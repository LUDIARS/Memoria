import type Database from 'better-sqlite3';

export interface ErrorLogEntry {id:number;occurred_at:string;method:string;path:string;status:number}

/** Persist bounded HTTP failure metadata, never request bodies, queries or credentials. */
export class ErrorLogStore {
  constructor(private readonly db:Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS app_http_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at TEXT NOT NULL,
      method TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL
    )`);
  }
  record(method:string,path:string,status:number,at=new Date().toISOString()):void {
    const safePath=path.split(/[?#]/,1)[0].slice(0,500).replace(/[a-zA-Z0-9_-]{40,}/g,':id');
    this.db.transaction(()=>{
      this.db.prepare('INSERT INTO app_http_errors (occurred_at,method,path,status) VALUES (?,?,?,?)')
        .run(at,method.slice(0,12),safePath,status);
      this.db.prepare('DELETE FROM app_http_errors WHERE id NOT IN (SELECT id FROM app_http_errors ORDER BY id DESC LIMIT 500)').run();
    })();
  }
  list():ErrorLogEntry[] {
    return this.db.prepare('SELECT id,occurred_at,method,path,status FROM app_http_errors ORDER BY id DESC LIMIT 200').all() as ErrorLogEntry[];
  }
}
