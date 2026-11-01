// Secrets aren't declared in wrangler.jsonc, so `wrangler types` doesn't
// know about them. Declare them here (optional, since they're unset
// until `wrangler secret put` / .dev.vars) to keep Env fully typed.
export {};

declare global {
	interface Env {
		BIRD_API_KEY?: string;
		BIRD_FROM_NUMBER?: string;
	}
}
