declare module "better-sqlite3" {
  type Params = unknown[] | Record<string, unknown>;

  class Statement {
    run(...params: unknown[]): unknown;
    run(params: Record<string, unknown>): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  class Database {
    constructor(filename: string);
    pragma(value: string): void;
    exec(sql: string): void;
    prepare(sql: string): Statement;
    transaction<T extends (...args: any[]) => unknown>(fn: T): T;
  }

  export default Database;
}
