// Backup safety primitives; no CLI, credentials, network target or activation.
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const MiB = 1024 * 1024;
export class BackupFailure extends Error {
  constructor(code) {
    // Only internal, fixed codes. Never attach a driver error, row or SQL.
    super(code);
    this.name = "BackupFailure";
  }
}
const fail = (code) => new BackupFailure(code);
const inside = (root, target) =>
  target === root || target.startsWith(root + path.sep);

export class BackupBudget {
  static async create({
    roots,
    milliseconds = 20 * 60 * 1000,
    workspaceBytes = 768 * MiB,
    archiveBytes = 64 * MiB,
    pollMilliseconds = 50,
  }) {
    if (
      !Array.isArray(roots) ||
      !roots.length ||
      !Number.isInteger(milliseconds) ||
      milliseconds < 1 ||
      milliseconds > 1200000 ||
      !Number.isInteger(workspaceBytes) ||
      workspaceBytes < 1 ||
      workspaceBytes > 768 * MiB ||
      !Number.isInteger(archiveBytes) ||
      archiveBytes < 1 ||
      archiveBytes > 64 * MiB ||
      !Number.isInteger(pollMilliseconds) ||
      pollMilliseconds < 1 ||
      pollMilliseconds > 100
    )
      throw fail("INVALID_LIMITS");
    try {
      for (const root of roots) {
        const s = await lstat(root);
        if (
          !path.isAbsolute(root) ||
          (await realpath(root)) !== root ||
          !s.isDirectory() ||
          s.uid !== process.getuid() ||
          s.mode & 0o077
        )
          throw fail("PRIVATE_WORKSPACE_REQUIRED");
      }
    } catch {
      throw fail("PRIVATE_WORKSPACE_REQUIRED");
    }
    const unique = [...new Set(roots)];
    const budget = new BackupBudget(
      unique.filter(
        (r) => !unique.some((other) => other !== r && inside(other, r)),
      ),
      milliseconds,
      workspaceBytes,
      archiveBytes,
      pollMilliseconds,
    );
    try {
      await budget.check();
    } catch (e) {
      budget.close();
      throw e;
    }
    budget.monitor();
    return budget;
  }
  constructor(
    roots,
    milliseconds,
    workspaceBytes,
    archiveBytes,
    pollMilliseconds,
  ) {
    this.roots = roots;
    this.deadline = performance.now() + milliseconds;
    this.workspaceBytes = workspaceBytes;
    this.archiveBytes = archiveBytes;
    this.pollMilliseconds = pollMilliseconds;
    this.controller = new AbortController();
    this.closed = false;
    this.timer = setTimeout(() => this.abort("TOTAL_DEADLINE"), milliseconds);
    this.onSignal = () => this.abort("CANCELLED");
    process.on("SIGINT", this.onSignal);
    process.on("SIGTERM", this.onSignal);
  }
  get signal() {
    return this.controller.signal;
  }
  abort(code = "CANCELLED") {
    if (!this.signal.aborted) this.controller.abort(fail(code));
  }
  assertActive() {
    if (this.closed) throw fail("BUDGET_CLOSED");
    if (performance.now() >= this.deadline) this.abort("TOTAL_DEADLINE");
    if (this.signal.aborted) throw this.signal.reason;
  }
  async race(operation) {
    // A passed promise may already have started; always consume its late failure.
    void Promise.resolve(operation).catch(() => {});
    this.assertActive();
    let onAbort;
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          onAbort = () => reject(this.signal.reason);
          this.signal.addEventListener("abort", onAbort, { once: true });
          if (this.signal.aborted) onAbort();
        }),
      ]);
    } catch (e) {
      throw e instanceof BackupFailure ? e : fail("OPERATION_FAILED");
    } finally {
      this.signal.removeEventListener("abort", onAbort);
    }
  }
  async check() {
    this.assertActive();
    let total = 0;
    const visit = async (target) => {
      this.assertActive();
      const s = await lstat(target);
      if (
        s.isSymbolicLink() ||
        (!s.isFile() && !s.isDirectory() && !s.isSocket())
      )
        throw fail("WORKSPACE_OBJECT_REFUSED");
      if (s.isDirectory()) {
        for (const name of await readdir(target)) {
          try {
            await visit(path.join(target, name));
          } catch (e) {
            // PostgreSQL may remove transient files while scanned.
            if (e.code !== "ENOENT") throw e;
          }
        }
      } else if (s.isFile()) {
        total += s.size;
        if (total > this.workspaceBytes) throw fail("WORKSPACE_LIMIT");
      }
    };
    try {
      for (const root of this.roots) await visit(root);
    } catch (e) {
      this.abort(
        e instanceof BackupFailure ? e.message : "WORKSPACE_CHECK_FAILED",
      );
      throw this.signal.reason;
    }
    this.assertActive();
    return total;
  }
  monitor() {
    this.poll = setTimeout(async () => {
      try {
        await this.check();
      } catch {
        return;
      }
      if (!this.closed && !this.signal.aborted) this.monitor();
    }, this.pollMilliseconds);
  }
  close() {
    this.abort("CANCELLED");
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.poll);
    process.removeListener("SIGINT", this.onSignal);
    process.removeListener("SIGTERM", this.onSignal);
  }
  async query(client, sql) {
    this.assertActive();
    if (client.pipeline) throw fail("PIPELINED_CONNECTION_REFUSED");
    const stop = () => {
      void client.end().catch(() => {});
    };
    this.signal.addEventListener("abort", stop, { once: true });
    try {
      const remaining = Math.max(
        1,
        Math.floor(this.deadline - performance.now()),
      );
      // Disconnect alone does not cancel a running server statement. Bound it
      // on the server too, including abandoned read-only snapshot transactions.
      await this.race(
        client.query(
          `SET statement_timeout='${remaining}ms'; SET lock_timeout='${Math.min(5000, remaining)}ms'; SET idle_in_transaction_session_timeout='${remaining}ms'`,
        ),
      );
      this.assertActive();
      return await this.race(client.query(sql));
    } catch (e) {
      throw e instanceof BackupFailure ? e : fail("QUERY_FAILED");
    } finally {
      this.signal.removeEventListener("abort", stop);
    }
  }
  async command(executable, args, { env = {}, archive, expected = 0 } = {}) {
    this.assertActive();
    let file, child, stop, closed, pump;
    let exited = false;
    let bytes = 0;
    try {
      if (archive) {
        const parent = path.dirname(archive);
        if (
          !path.isAbsolute(archive) ||
          (await realpath(parent)) !== parent ||
          !this.roots.some((root) => inside(root, archive))
        )
          throw fail("ARCHIVE_PATH_REFUSED");
        file = await open(
          archive,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
      }
      this.assertActive();
      child = spawn(executable, args, {
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      stop = () => {
        if (exited) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      this.signal.addEventListener("abort", stop, { once: true });
      // Drain, never retain or forward stderr: it may contain row/credential data.
      child.stderr.resume();
      closed = new Promise((resolve) => {
        child.on("error", () => {
          exited = true;
          resolve(null);
        });
        child.on("close", (code) => {
          exited = true;
          resolve(code);
        });
      });
      pump = (async () => {
        for await (const chunk of child.stdout) {
          this.assertActive();
          if (file) {
            if (bytes + chunk.length > this.archiveBytes) {
              this.abort("ARCHIVE_LIMIT");
              throw this.signal.reason;
            }
            await file.writeFile(chunk);
            bytes += chunk.length;
          }
        }
      })();
      const [, code] = await this.race(Promise.all([pump, closed]));
      if (code !== expected) throw fail("PROCESS_FAILED");
      await this.check();
      return { code, bytes };
    } catch (e) {
      const safe = e instanceof BackupFailure ? e : fail("PROCESS_FAILED");
      this.abort(safe.message);
      throw safe;
    } finally {
      if (stop) {
        stop();
        this.signal.removeEventListener("abort", stop);
      }
      if (closed) await closed;
      if (pump) await pump.catch(() => {});
      if (file) await file.close();
    }
  }
}

export function sameMetadata(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw fail("METADATA_MISMATCH");
}

const identifier = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    throw fail("INVENTORY_REFUSED");
  return '"' + value + '"';
};

// Caller keeps source's exported REPEATABLE READ snapshot alive from dump through
// comparison; restored client must also be inside a read-only transaction.
// Cursor batch = 1, <=1MiB UTF8 per row. No row/hash is returned or written.
export async function compareTables(budget, source, restored, tables) {
  for (const c of [source, restored]) {
    const isolation = (await budget.query(c, "SHOW transaction_isolation"))
      .rows[0];
    const readonly = (await budget.query(c, "SHOW transaction_read_only"))
      .rows[0];
    if (
      isolation.transaction_isolation !== "repeatable read" ||
      readonly.transaction_read_only !== "on"
    )
      throw fail("SNAPSHOT_REQUIRED");
    await budget.query(
      c,
      "SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO, YMD'; SET LOCAL intervalstyle='postgres'; SET LOCAL extra_float_digits=3; SET LOCAL bytea_output='hex'",
    );
  }
  let count = 0;
  for (const { schemaname, tablename } of tables) {
    const table = identifier(schemaname) + "." + identifier(tablename);
    const sql =
      "DECLARE p06_rows NO SCROLL CURSOR FOR SELECT CASE WHEN octet_length(row_to_json(t)::text)<=1048576 THEN row_to_json(t)::text ELSE NULL END AS value FROM " +
      table +
      ' t ORDER BY id::text COLLATE "C"';
    for (const c of [source, restored]) await budget.query(c, sql);
    while (true) {
      const a = (await budget.query(source, "FETCH FORWARD 1 FROM p06_rows"))
        .rows;
      const b = (await budget.query(restored, "FETCH FORWARD 1 FROM p06_rows"))
        .rows;
      if (a.length !== b.length) throw fail("ROW_MISMATCH");
      if (!a.length) break;
      if (a[0].value === null || b[0].value === null)
        throw fail("ROW_SIZE_LIMIT");
      if (
        typeof a[0].value !== "string" ||
        typeof b[0].value !== "string" ||
        a[0].value !== b[0].value
      )
        throw fail("ROW_MISMATCH");
      count++;
    }
    for (const c of [source, restored]) await budget.query(c, "CLOSE p06_rows");
  }
  return { tables: tables.length, rows: count, matched: true };
}
