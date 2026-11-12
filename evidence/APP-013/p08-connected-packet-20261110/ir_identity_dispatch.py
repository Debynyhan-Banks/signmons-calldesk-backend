"""Local operational adapter; external authority remains the caller's responsibility."""
import packet
q = packet.q


def resolve(commands):
    expected = [next(d for d in q.current_cli_contract() if d['id'] == name)
                for name in ('owner', 'project', 'identity')]
    q.need(q.model.digest(commands) == q.model.digest(expected), 'IR_COMMAND_SCOPE')
    for descriptor in expected:
        q.validate_cli_descriptor(descriptor)
    return expected


def identity_state(value):
    q.need(isinstance(value, dict) and value.get('email') == q.model.IDENTITY
           and isinstance(value.get('uniqueId'), str) and bool(value['uniqueId']),
           'IR_IDENTITY_MISMATCH')
    q.need(type(value.get('disabled')) is bool, 'IR_DISABLED_UNKNOWN')
    return 'DISABLED' if value['disabled'] else 'ENABLED'


def dispatch(commands, io, read_deadline, close_deadline, reserve, observe):
    try:
        for descriptor in resolve(commands):
            reserve(descriptor['id'])
            observe(descriptor['id'], q.strict_json(io.cli(descriptor, read_deadline)))
    finally:
        q.need(io.close(close_deadline), 'IR_PROCESS_CLEANUP_UNCONFIRMED')
