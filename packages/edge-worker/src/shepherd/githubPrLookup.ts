import type { PrLookup } from "./types.js";

/** Fetches PR title/author/refs via the GitHub REST API. Throws on any non-2xx. */
export function createGithubPrLookup(
	getToken: () => Promise<string | undefined>,
): PrLookup {
	return async (repo, pr) => {
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		};
		const token = await getToken();
		if (token) {
			headers.Authorization = `Bearer ${token}`;
		}
		const response = await fetch(
			`https://api.github.com/repos/${repo}/pulls/${pr}`,
			{ headers },
		);
		if (!response.ok) {
			throw new Error(`GitHub API ${response.status} for ${repo}#${pr}`);
		}
		const data = (await response.json()) as {
			title: string;
			user: { login: string };
			head: { ref: string; sha: string };
			base: { ref: string };
		};
		return {
			title: data.title,
			author: data.user.login,
			headRef: data.head.ref,
			headSha: data.head.sha,
			baseRef: data.base.ref,
		};
	};
}
