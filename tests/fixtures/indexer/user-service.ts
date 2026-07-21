import { TokenStore } from "./nested";

export class UserService {
	constructor(private readonly store: TokenStore) {}

	findById(id: string) {
		return this.store.load(id);
	}

	static async create() {
		return new UserService(new TokenStore());
	}
}
