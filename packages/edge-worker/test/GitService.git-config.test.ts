import { afterEach, describe, expect, it } from "vitest";
import { gitCommand } from "../src/GitService.js";

const original = process.env.CYRUS_GIT_CONFIG;

afterEach(() => {
	if (original === undefined) delete process.env.CYRUS_GIT_CONFIG;
	else process.env.CYRUS_GIT_CONFIG = original;
});

describe("gitCommand", () => {
	it("is plain git when unset", () => {
		delete process.env.CYRUS_GIT_CONFIG;
		expect(gitCommand()).toBe("git");
	});

	it("is plain git when blank", () => {
		process.env.CYRUS_GIT_CONFIG = "   ";
		expect(gitCommand()).toBe("git");
	});

	it("turns each pair into -c", () => {
		process.env.CYRUS_GIT_CONFIG =
			"filter.git-crypt.smudge=cat filter.git-crypt.clean=cat";
		expect(gitCommand()).toBe(
			'git -c "filter.git-crypt.smudge=cat" -c "filter.git-crypt.clean=cat"',
		);
	});
});
