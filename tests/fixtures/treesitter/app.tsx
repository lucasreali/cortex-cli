import React from "react";
import { handleCreateUser } from "./handlers";

export function App() {
	const onSubmit = (name: string) => {
		console.log(handleCreateUser, name);
	};
	return <button onClick={() => onSubmit("ana")}>criar</button>;
}

class ErrorBoundary extends React.Component {
	render() {
		return null;
	}
}

export default ErrorBoundary;
