"""Disposable local design probe, not an IQ1 execution interface."""
import errno
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

PYTHON = '/opt/homebrew/Cellar/python@3.14/3.14.2/Frameworks/Python.framework/Versions/3.14/bin/python3.14'
SDK = Path('/opt/homebrew/bin/gcloud').resolve().parents[1]


def main():
    results = {}
    with tempfile.TemporaryDirectory(prefix='iq1-containment-probe-') as directory:
        profile = ('(version 1)(allow default)(deny process-fork)(deny network*)'
                   '(deny file-read* file-write* (subpath "/Users/debynyhanbanks/.config/gcloud"))')
        base = ['/usr/bin/sandbox-exec', '-p', profile, PYTHON, '-I', '-B']
        environment = {'HOME': directory, 'PATH': '/usr/bin:/bin',
                       'CLOUDSDK_CONFIG': directory, 'CLOUDSDK_CORE_DISABLE_USAGE_REPORTING': 'true',
                       'CLOUDSDK_CORE_DISABLE_FILE_LOGGING': 'true', 'CLOUDSDK_CORE_DISABLE_PROMPTS': 'true',
                       'CLOUDSDK_PAGER': '', 'PAGER': 'cat', 'PYTHONDONTWRITEBYTECODE': '1'}
        cases = {
            'single_process': 'print("PASS")',
            'popen_detached': 'subprocess.Popen([sys.executable,"-c","pass"],start_new_session=True)',
            'fork': 'os.fork()',
            'posix_spawn': 'os.posix_spawn("/usr/bin/true",["true"],{})',
        }
        for name, code in cases.items():
            if name != 'single_process':
                code = ('import os,sys,subprocess,errno\ntry:\n ' + code +
                        '\nexcept OSError as e:\n print("PASS" if e.errno==errno.EPERM else "FAIL")'
                        '\nelse:\n print("FAIL")')
            value = subprocess.run([*base, '-c', code], env=environment, capture_output=True, timeout=8)
            results[name] = value.returncode == 0 and value.stdout.strip() == b'PASS'
        # Help parsing only, with empty configuration and OS-denied network and
        # real credential-directory access. No operational command is invoked.
        value = subprocess.run([*base, '-S', str(SDK / 'lib/gcloud.py'),
                                'iam', 'service-accounts', 'enable', '--help'],
                               env=environment, capture_output=True, timeout=8)
        results['isolated_sdk_help'] = value.returncode == 0 and b'Enable an IAM service account' in value.stdout
        results['sdk_help_exit'] = value.returncode
    assert all(results[name] for name in cases), 'CONTAINMENT_PROBE_FAILED'
    return {'results': results, 'providerCalls': 0, 'realCredentialReads': 0,
            'qualificationReady': False, 'scope': 'LOCAL_DESIGN_PROBE_ONLY'}


if __name__ == '__main__':
    print(json.dumps(main(), sort_keys=True))
