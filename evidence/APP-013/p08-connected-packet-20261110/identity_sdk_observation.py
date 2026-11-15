"""Optional same-response labels. Never grants authority or changes SDK results."""
import base64
import contextlib
import json
import os
from pathlib import Path
import re
import runpy
import secrets
import stat
import sys

SDK = Path('/opt/homebrew/share/google-cloud-sdk/lib/gcloud.py')
IDENTITY = 'signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com'
SLOTS = frozenset({'main-2', 'main-4', 'main-5', 'main-6', 'cleanup-2', 'cleanup-4', 'cleanup-5', 'cleanup-6', 'cleanup-7'})
STATES = frozenset({'BOOL_TRUE', 'BOOL_FALSE', 'MISSING', 'NULL', 'OTHER'})
SHAPES = frozenset({'OBJECT', 'OTHER', 'INVALID', 'TOO_LARGE'})


def require(ok):
    if not ok:
        raise ValueError('SD3_UNAVAILABLE')


def pairs(items):
    result = {}
    for key, value in items:
        require(key not in result)
        result[key] = value
    return result


def state(value):
    if type(value) is not dict or 'disabled' not in value:
        return 'MISSING'
    value = value['disabled']
    return ('BOOL_TRUE' if value is True else 'BOOL_FALSE' if value is False
            else 'NULL' if value is None else 'OTHER')


def classify(content):
    """Only fixed labels escape; no headers or arbitrary values are examined."""
    if type(content) not in (str, bytes) or len(content) > 65536:
        return {'shape': 'TOO_LARGE', 'disabled': 'OTHER', 'identity': 'UNKNOWN'}
    try:
        if type(content) is str and len(content.encode('utf-8')) > 65536:
            return {'shape': 'TOO_LARGE', 'disabled': 'OTHER', 'identity': 'UNKNOWN'}
        value = json.loads(content, object_pairs_hook=pairs,
                           parse_constant=lambda _: require(False))
        if type(value) is not dict:
            return {'shape': 'OTHER', 'disabled': 'OTHER', 'identity': 'UNKNOWN'}
        return {'shape': 'OBJECT', 'disabled': state(value),
                'identity': 'MATCH' if value.get('email') == IDENTITY else 'MISMATCH'}
    except Exception:
        return {'shape': 'INVALID', 'disabled': 'OTHER', 'identity': 'UNKNOWN'}


def valid_labels(value):
    if type(value) is not dict:
        return False
    if set(value) == {'status'}:
        return value['status'] in {'NO_MATCH', 'MULTIPLE', 'UNAVAILABLE'}
    return (set(value) == {'status', 'requestMatch', 'http', 'shape', 'disabled',
                           'identity', 'decoded', 'decoder'} and
            value['status'] == 'OBSERVED' and value['requestMatch'] is True and
            value['http'] in {'SUCCESS', 'OTHER'} and value['shape'] in SHAPES and
            value['disabled'] in STATES and value['identity'] in {'MATCH', 'MISMATCH', 'UNKNOWN'} and
            value['decoded'] in STATES | {'UNAVAILABLE'} and
            value['decoder'] in {'RETURNED', 'RAISED', 'UNAVAILABLE'})


class Capture:
    def __init__(self):
        self.count = 0
        self.value = {'status': 'NO_MATCH'}

    @contextlib.contextmanager
    def install(self, service_class, message_to_dict):
        original = service_class.ProcessHttpResponse
        capture = self

        def observed(service, config, response, request=None):
            try:
                matches = (getattr(config, 'method_id', None) == 'iam.projects.serviceAccounts.get' and
                           getattr(config, 'response_type_name', None) == 'ServiceAccount' and
                           getattr(config, 'request_type_name', None) == 'IamProjectsServiceAccountsGetRequest' and
                           getattr(request, 'name', None) in
                           {'projects/-/serviceAccounts/' + IDENTITY,
                            'projects/signmons/serviceAccounts/' + IDENTITY})
            except Exception:
                matches = False
            if not matches:
                return original(service, config, response, request)
            capture.count += 1
            labels = None
            try:
                labels = {'status': 'OBSERVED', 'requestMatch': True,
                          'http': 'SUCCESS' if response.status_code in (200, 201, 204) else 'OTHER',
                          **classify(response.content), 'decoded': 'UNAVAILABLE', 'decoder': 'UNAVAILABLE'}
            except Exception:
                pass
            try:
                result = original(service, config, response, request)
            except BaseException:
                if labels is not None:
                    labels['decoder'] = 'RAISED'
                raise
            else:
                try:
                    if labels is not None:
                        labels['decoder'] = 'RETURNED'
                        labels['decoded'] = state(message_to_dict(result))
                except Exception:
                    pass
                return result
            finally:
                capture.value = ({'status': 'MULTIPLE'} if capture.count != 1 else labels
                                 if labels is not None and valid_labels(labels) and
                                 labels['identity'] == 'MATCH' and labels['shape'] == 'OBJECT'
                                 else {'status': 'UNAVAILABLE'})

        service_class.ProcessHttpResponse = observed
        try:
            yield self
        finally:
            service_class.ProcessHttpResponse = original


def identity(st):
    return [st.st_dev, st.st_ino]


def safe_dir(st):
    return stat.S_ISDIR(st.st_mode) and stat.S_IMODE(st.st_mode) == 0o700 and st.st_uid == os.getuid()


def safe_file(st):
    return (stat.S_ISREG(st.st_mode) and stat.S_IMODE(st.st_mode) == 0o600 and
            st.st_uid == os.getuid() and st.st_nlink == 1)


def validate_binding(binding):
    require(type(binding) is dict and set(binding) ==
            {'operationId', 'rootIdentity', 'directoryIdentity', 'fileIdentity', 'slot', 'nonce'})
    require(type(binding['operationId']) is str and
            re.fullmatch('[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}', binding['operationId']))
    require(binding['slot'] in SLOTS and type(binding['nonce']) is str and
            re.fullmatch('[a-f0-9]{32}', binding['nonce']))
    for key in ('rootIdentity', 'directoryIdentity', 'fileIdentity'):
        require(type(binding[key]) is list and len(binding[key]) == 2 and
                all(type(v) is int and v >= 0 for v in binding[key]))


def directory_for(operation):
    return Path('/private/tmp/p08-iq1-observations-' + operation)


def publish(binding, labels, *, directory=None):
    """Fill only the exact empty inode pre-reserved by the owning worker."""
    validate_binding(binding)
    require(valid_labels(labels))
    directory = directory_for(binding['operationId']) if directory is None else Path(directory)
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        require(safe_dir(os.fstat(fd)) and identity(os.fstat(fd)) == binding['directoryIdentity'])
        out = os.open(binding['slot'] + '.json', os.O_WRONLY | os.O_NOFOLLOW, dir_fd=fd)
        try:
            st = os.fstat(out)
            require(safe_file(st) and identity(st) == binding['fileIdentity'] and st.st_size == 0)
            data = json.dumps({'binding': binding, 'labels': labels}, separators=(',', ':')).encode()
            require(len(data) <= 4096)
            while data:
                written = os.write(out, data)
                require(written > 0)
                data = data[written:]
            os.fsync(out)
        finally:
            os.close(out)
    finally:
        os.close(fd)


class Store:
    """Optional storage never participates in authoritative execution gates."""
    def __init__(self, operation, root_identity, *, directory=None):
        self.operation, self.root_identity = operation, root_identity
        self.path = directory_for(operation) if directory is None else Path(directory)
        self.fd = None
        self.owned = False
        self.unknown = False
        self.records = {}
        self.untrusted = set()
        try:
            self.path.mkdir(mode=0o700)
            self.owned = True
            self.fd = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            require(safe_dir(os.fstat(self.fd)))
            self.directory_identity = identity(os.fstat(self.fd))
        except Exception:
            self.unknown = self.owned or self.path.exists() or self.path.is_symlink()

    def check(self):
        require(self.fd is not None and safe_dir(os.fstat(self.fd)))
        st = self.path.lstat()
        require(safe_dir(st) and identity(st) == self.directory_identity == identity(os.fstat(self.fd)))

    def prepare(self, slot):
        try:
            self.check()
            require(slot in SLOTS and slot not in self.records and len(self.records) < 9)
            fd = os.open(slot + '.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=self.fd)
            try:
                st = os.fstat(fd)
                require(safe_file(st))
                binding = {'operationId': self.operation, 'rootIdentity': self.root_identity,
                           'directoryIdentity': self.directory_identity, 'fileIdentity': identity(st),
                           'slot': slot, 'nonce': secrets.token_hex(16)}
                self.records[slot] = binding
            finally:
                os.close(fd)
            validate_binding(binding)
            return binding
        except Exception:
            return None

    def read(self, binding):
        try:
            self.check()
            validate_binding(binding)
            require(self.records.get(binding['slot']) == binding)
            fd = os.open(binding['slot'] + '.json', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self.fd)
            try:
                st = os.fstat(fd)
                require(safe_file(st) and identity(st) == binding['fileIdentity'])
                require(st.st_size <= 4096)
                raw = os.read(fd, 4097)
                require(len(raw) <= 4096)
            finally:
                os.close(fd)
            value = json.loads(raw, object_pairs_hook=pairs)
            if not (type(value) is dict and set(value) == {'binding', 'labels'} and
                    value['binding'] == binding and valid_labels(value['labels'])):
                self.untrusted.add(binding['slot'])
                require(False)
            return value['labels']
        except Exception:
            return {'status': 'UNAVAILABLE'}

    def close(self):
        """Only remove pre-owned exact inodes, including partial safe writes."""
        if not self.owned:
            return not self.unknown
        okay = True
        try:
            self.check()
            for slot, binding in self.records.items():
                try:
                    require(slot not in self.untrusted)
                    st = os.stat(slot + '.json', dir_fd=self.fd, follow_symlinks=False)
                    require(safe_file(st) and identity(st) == binding['fileIdentity'])
                    os.unlink(slot + '.json', dir_fd=self.fd)
                except FileNotFoundError:
                    continue
                except Exception:
                    okay = False
            self.check()
            if okay:
                self.path.rmdir()  # Unknown extra files make this refuse; never recurse.
        except Exception:
            okay = False
        finally:
            if self.fd is not None:
                os.close(self.fd)
                self.fd = None
        return okay and not self.unknown


def encode_binding(binding):
    if binding is None:
        return '-'
    validate_binding(binding)
    return base64.urlsafe_b64encode(json.dumps(binding, separators=(',', ':')).encode()).decode()


def valid_arguments(argv):
    return argv in [
        ['iam', 'service-accounts', 'describe', IDENTITY, '--project', 'signmons',
         '--format=json(email,disabled,uniqueId)'],
        ['iam', 'service-accounts', 'describe', IDENTITY, '--project=signmons',
         '--format=json(email,disabled)']]


def execute(argv, binding, *, service_class, message_to_dict, run_sdk, publish_receipt=publish):
    require(valid_arguments(argv))
    if binding is not None:
        validate_binding(binding)
    capture = Capture()
    try:
        with capture.install(service_class, message_to_dict):
            return run_sdk(argv)
    finally:
        if binding is not None:
            try:
                publish_receipt(binding, capture.value)
            except Exception:
                pass  # Optional publication cannot replace SDK outcome.


def main(argv):
    require(len(argv) >= 4 and argv[0] == '--binding' and argv[2] == '--')
    require(len(argv[1]) <= 2048)
    binding = None if argv[1] == '-' else json.loads(base64.urlsafe_b64decode(argv[1]), object_pairs_hook=pairs)
    require(valid_arguments(argv[3:]))
    if binding is not None:
        validate_binding(binding)
    # Fixed installed library paths; no credential initialization until normal CLI entry.
    sys.path[:0] = [str(SDK.parent), str(SDK.parent / 'third_party')]
    from apitools.base.py import base_api, encoding
    def run_sdk(arguments):
        sys.argv = [str(SDK), *arguments]
        return runpy.run_path(str(SDK), run_name='__main__')
    return execute(argv[3:], binding, service_class=base_api.BaseApiService,
                   message_to_dict=encoding.MessageToDict, run_sdk=run_sdk)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except SystemExit:
        raise
    except BaseException:
        sys.exit(1)  # Never print exception text which may contain a provider body.
