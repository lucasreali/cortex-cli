import { UserService } from "./user-service";

export function App({ service }: { service: UserService }) {
	return (
		<main>
			<Header />
			<p>{String(service)}</p>
		</main>
	);
}

export const Header = () => <header>cortex</header>;
