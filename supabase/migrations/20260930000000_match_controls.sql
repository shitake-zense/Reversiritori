-- The match state remains server-authored. This migration accepts new control
-- transitions and keeps every active turn's deadline on the database clock.
create or replace function public.commit_match_state(p_id uuid, p_version integer, p_state jsonb, p_operation text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_old public.matches%rowtype; v_state jsonb; v_now timestamptz;
  v_pending jsonb; v_remaining integer;
begin
  select * into v_old from public.matches where id = p_id for update;
  if not found or v_old.version <> p_version or (p_state->>'version')::integer <> p_version + 1 then
    return null;
  end if;
  v_now := clock_timestamp();
  v_pending := v_old.state->'pendingRequest';
  if p_operation = 'expire' then
    if v_pending is not null and v_pending <> 'null'::jsonb then
      if v_now < (v_pending->>'expiresAt')::timestamptz then return null; end if;
    elsif v_old.state->>'status' <> 'playing' or v_now < (v_old.state->>'deadlineAt')::timestamptz then
      return null;
    end if;
  elsif p_operation = 'move' then
    if v_old.state->>'status' <> 'playing' or v_pending is not null and v_pending <> 'null'::jsonb
      or v_now >= (v_old.state->>'deadlineAt')::timestamptz then return null; end if;
  elsif p_operation = 'resign' then
    if v_old.state->>'status' not in ('playing', 'paused') then return null; end if;
  elsif p_operation = 'ready' then
    if v_old.state->>'status' <> 'waiting' then return null; end if;
  elsif p_operation = 'control_request' then
    if v_old.state->>'status' not in ('playing', 'paused') or v_pending is not null and v_pending <> 'null'::jsonb then return null; end if;
    if v_old.state->>'status' = 'playing' and v_now >= (v_old.state->>'deadlineAt')::timestamptz then return null; end if;
  elsif p_operation = 'control_respond' then
    if v_pending is null or v_pending = 'null'::jsonb or v_now >= (v_pending->>'expiresAt')::timestamptz then return null; end if;
  else
    return null;
  end if;
  v_state := p_state;
  if p_operation in ('move', 'ready') and v_state->>'status' = 'playing' then
    v_state := jsonb_set(v_state, '{deadlineAt}', to_jsonb(v_now + interval '20 seconds'));
  elsif p_operation in ('control_respond', 'expire') and v_state->>'status' = 'playing'
      and v_pending is not null and v_pending <> 'null'::jsonb then
    if p_operation = 'control_respond' and jsonb_array_length(v_state->'moves') < jsonb_array_length(v_old.state->'moves') then
      v_state := jsonb_set(v_state, '{deadlineAt}', to_jsonb(v_now + interval '20 seconds'));
    else
      v_remaining := (v_pending->>'remainingMs')::integer;
      v_state := jsonb_set(v_state, '{deadlineAt}', to_jsonb(v_now + v_remaining * interval '1 millisecond'));
    end if;
  end if;
  update public.matches set state = v_state, version = p_version + 1, updated_at = v_now where id = p_id;
  return v_state;
end $$;
