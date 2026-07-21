const database = require("./database");
const { join } = require("node:path");

function connect() {
	return database.open(join(__dirname, "store"));
}

module.exports = { connect };
