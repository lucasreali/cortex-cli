import { connect } from "./legacy-require";

const settings = require("./settings");

export function start() {
	return connect(settings);
}

export const stop = () => null;
