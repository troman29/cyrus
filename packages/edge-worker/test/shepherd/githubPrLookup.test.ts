import { afterEach, describe, expect, it, vi } from "vitest";
import { createGithubPrLookup } from "../../src/shepherd/githubPrLookup.js";

const prBody = {
	title: "t",
	user: { login: "thomas5788" },
	head: { ref: "h", sha: "s" },
	base: { ref: "dev" },
};

describe("createGithubPrLookup", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function stubFetch(ok = true) {
		const fetchMock = vi.fn(async () => ({
			ok,
			status: ok ? 200 : 404,
			json: async () => prBody,
		}));
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	it("prefers the webhook installation token over the local provider", async () => {
		const fetchMock = stubFetch();
		const getToken = vi.fn(async () => "app-token");
		const meta = await createGithubPrLookup(getToken)("o/r", 5, "inst-token");
		expect(meta.author).toBe("thomas5788");
		const init = fetchMock.mock.calls[0][1] as unknown as {
			headers: Record<string, string>;
		};
		expect(init.headers.Authorization).toBe("Bearer inst-token");
		expect(getToken).not.toHaveBeenCalled();
	});

	it("falls back to the local token and throws on API errors", async () => {
		const fetchMock = stubFetch();
		await createGithubPrLookup(async () => "app-token")("o/r", 5);
		expect(
			(
				fetchMock.mock.calls[0][1] as unknown as {
					headers: Record<string, string>;
				}
			).headers.Authorization,
		).toBe("Bearer app-token");
		stubFetch(false);
		await expect(
			createGithubPrLookup(async () => undefined)("o/r", 5),
		).rejects.toThrow(/404/);
	});
});
