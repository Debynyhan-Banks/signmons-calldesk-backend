"""Exact private inventory; no historical directory scanning or deletion."""
import json
import os
import re
import stat
from pathlib import Path


class Stop(Exception):
    pass


def need(ok, code):
    if not ok:
        raise Stop(code)


NAMES = frozenset({'envelope.json', 'attempt.json', 'journal.json', 'journal-next.json',
                   'journal.json.auth-next', 'owned-receipt.json', 'closeout.json',
                   'independent-closeout.json', 'entry.lock', 'result.json',
                   *(f'child-{n}.json' for n in range(1, 9))})
PRIVATE = frozenset({'envelope.json', 'owned-receipt.json'})


def inspect(root, operation):
    root = Path(root)
    need(re.fullmatch(r'[a-f0-9-]{36}', operation) and
         str(root) == '/private/tmp/p08-coordinator-' + operation, 'PRIVATE_ROOT_SCOPE')
    s = root.lstat()
    need(stat.S_ISDIR(s.st_mode) and not root.is_symlink() and
         stat.S_IMODE(s.st_mode) == 0o700 and root.resolve() == root, 'PRIVATE_ROOT_MODE')
    for p in root.iterdir():
        s = p.lstat()
        need(p.name in NAMES and stat.S_ISREG(s.st_mode) and not p.is_symlink() and
             stat.S_IMODE(s.st_mode) == 0o600 and s.st_nlink == 1, 'PRIVATE_FOREIGN_OR_MODE')
    return root


def read(path):
    path = Path(path)
    s = path.lstat()
    need(stat.S_ISREG(s.st_mode) and not path.is_symlink() and
         stat.S_IMODE(s.st_mode) == 0o600 and s.st_nlink == 1 and s.st_size <= 65536,
         'PRIVATE_INPUT_SHAPE')
    with path.open() as f:
        return json.load(f)


def reserve(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, json.dumps(value, sort_keys=True, separators=(',', ':')).encode())
        os.fsync(fd)
    finally:
        os.close(fd)


def purge(root, operation):
    root = inspect(root, operation)
    # Never delete an uncommitted intent; it needs reconciliation, not optimistic cleanup.
    need(not any((root / n).exists() for n in ('journal-next.json', 'journal.json.auth-next')),
         'UNCOMMITTED_INTENT')
    for name in PRIVATE:
        p = root / name
        if p.exists():
            p.unlink()
    inspect(root, operation)
    return all(not (root / n).exists() and not (root / n).is_symlink() for n in PRIVATE)
