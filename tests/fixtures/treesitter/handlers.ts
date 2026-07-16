import type { UserService } from "./user-service";

export const handleCreateUser = (service: UserService, name: string) => {
	return service.createUser(name);
};

export const handleFindUser = (service: UserService, id: string) => {
	return service.findUser(id);
};

export function parseRequestBody(raw: string): Record<string, unknown> {
	return JSON.parse(raw);
}
