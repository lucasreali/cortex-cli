import type { Database } from "bun:sqlite";
import { randomUUIDv7 } from "bun";

export class UserService {
	private database: Database;

	constructor(database: Database) {
		this.database = database;
	}

	createUser(name: string): string {
		const id = randomUUIDv7();
		this.database.run("INSERT INTO users (id, name) VALUES (?, ?)", [id, name]);
		return id;
	}

	findUser(id: string): unknown {
		return this.database.query("SELECT * FROM users WHERE id = ?").get(id);
	}
}
