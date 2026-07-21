import createServer from "./default-export";
import { UserService } from "./user-service";
import * as path from "node:path";
import "./side-effect";
import type { User } from "./types-only";

export function bootstrap(user: User): UserService {
	return new UserService(createServer(Number(path.sep)), user);
}
