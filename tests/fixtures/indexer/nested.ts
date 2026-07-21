export class TokenStore {
	load(id: string) {
		return id;
	}
}

export class AuthService {
	constructor(private readonly store: TokenStore) {}

	validateToken(token: string) {
		return this.store.load(token) !== "";
	}
}
