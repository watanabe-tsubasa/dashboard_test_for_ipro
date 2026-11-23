import { readFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";

export interface Statement {
  sql: string;
  params?: readonly (number | string)[];
}

export type Row = Record<string, unknown>;

export interface Database {
  batch(statements: readonly Statement[]): Promise<Row[][]>;
}

export function readD1Config(
  env: Readonly<Record<string, string | undefined>>,
) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const database = env.CLOUDFLARE_D1_DATABASE_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (
    !account ||
    !/^[0-9a-f]{32}$/i.test(account) ||
    !database ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(database) ||
    !token ||
    !/^[\w-]+$/.test(token)
  ) {
    throw new Error(
      "Set valid CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID and CLOUDFLARE_API_TOKEN in .env.local.",
    );
  }
  return { account, database, token };
}

function hasErrors(errors: unknown): boolean {
  return errors !== undefined && (!Array.isArray(errors) || errors.length > 0);
}

const retryableHttp = new Set([429, 500, 502, 503, 504]);
const retryableNetwork = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function isTransientNetwork(error: unknown): boolean {
  const failure = error as { name?: string; cause?: { code?: string } } | null;
  return (
    failure?.name === "TimeoutError" ||
    retryableNetwork.has(failure?.cause?.code ?? "")
  );
}

function apiRetryDecision(
  data: Record<string, unknown> | undefined,
): boolean | undefined {
  const errors: unknown[] = Array.isArray(data?.errors) ? [...data.errors] : [];
  if (Array.isArray(data?.result)) {
    for (const item of data.result) {
      if (Array.isArray(item?.errors)) errors.push(...item.errors);
      if (typeof item?.error === "string") errors.push({ message: item.error });
    }
  }
  let retry = false;
  for (const item of errors) {
    const { code, message } = (item ?? {}) as Record<string, unknown>;
    const text = typeof message === "string" ? message : "";
    if (
      code === 7403 ||
      code === 7404 ||
      code === 7406 ||
      code === 10000 ||
      /syntax error|SQLITE_(?:AUTH|CONSTRAINT|ERROR)|no such (?:table|column)|storage limit|daily row (?:read|write) limit/i.test(
        text,
      )
    ) {
      return false;
    }
    if (
      code === 7429 ||
      /network connection lost|storage caused object to be reset|code was updated|replica disconnected|transient issue on remote node/i.test(
        text,
      )
    ) {
      retry = true;
    }
  }
  return retry || (errors.length ? false : undefined);
}

export function d1Database(
  { account, database, token }: ReturnType<typeof readD1Config>,
  send: typeof fetch = fetch,
  delay: (milliseconds: number) => Promise<void> = wait,
): Database {
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`;
  return {
    async batch(statements) {
      const body = JSON.stringify({
        batch: statements.map(({ sql, params }) => ({
          sql,
          ...(params ? { params: params.map(String) } : {}),
        })),
      });
      for (let attempt = 0; attempt < 3; attempt++) {
        let response: Response;
        try {
          response = await send(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body,
            redirect: "error",
            signal: AbortSignal.timeout(35_000),
          });
        } catch (error) {
          if (!isTransientNetwork(error))
            throw new Error("D1 connection failed.");
          if (attempt === 2)
            throw new Error("D1 connection or timeout after three attempts.");
          await delay(250 * 2 ** attempt);
          continue;
        }

        let data: Record<string, unknown> | undefined;
        if (
          response.ok ||
          /\bjson\b/i.test(response.headers.get("Content-Type") ?? "")
        ) {
          const value: unknown = await response.json().catch(() => undefined);
          if (value && typeof value === "object" && !Array.isArray(value)) {
            data = value as Record<string, unknown>;
          }
        } else {
          await response.body?.cancel().catch(() => {});
        }
        const decision = apiRetryDecision(data);
        if (
          attempt < 2 &&
          (decision === true ||
            (decision !== false && retryableHttp.has(response.status)))
        ) {
          const hint = response.headers.get("Retry-After");
          const retryMs =
            hint && /^\d+$/.test(hint)
              ? Number(hint) * 1000
              : Date.parse(hint ?? "") - Date.now();
          await delay(
            Math.min(5000, Math.max(250 * 2 ** attempt, retryMs || 0)),
          );
          continue;
        }

        if (!response.ok)
          throw new Error(`D1 query failed with HTTP ${response.status}.`);
        if (!data) throw new Error("D1 returned invalid JSON.");
        const { success, errors, result } = data;
        if (
          success !== true ||
          hasErrors(errors) ||
          !Array.isArray(result) ||
          result.length !== statements.length
        ) {
          throw new Error(
            "D1 rejected the batch or returned an incomplete result.",
          );
        }
        return result.map((item, index) => {
          if (
            item?.success !== true ||
            hasErrors(item.errors) ||
            (item.error !== undefined && item.error !== null)
          ) {
            throw new Error(`D1 rejected statement ${index + 1} in the batch.`);
          }
          if (
            item.results !== undefined &&
            (!Array.isArray(item.results) ||
              item.results.some(
                (row: unknown) =>
                  row === null || typeof row !== "object" || Array.isArray(row),
              ))
          ) {
            throw new Error(
              `D1 returned invalid rows for statement ${index + 1}.`,
            );
          }
          return item.results ?? [];
        });
      }
      throw new Error("D1 retry limit reached.");
    },
  };
}

export async function migrate(db: Database) {
  // The versioned schema contains only SQL statements with no embedded semicolons.
  const sql = await readFile(
    new URL("../../../db/migrations/0001_init.sql", import.meta.url),
    "utf8",
  );
  await db.batch(
    sql
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((sql) => ({ sql })),
  );
}
