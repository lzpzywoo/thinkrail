import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ThinkRailRepoSection } from "./GithubSettings";

describe("ThinkRailRepoSection", () => {
	test("renders current version, upstream version, and repository link", () => {
		const markup = renderToStaticMarkup(
			<ThinkRailRepoSection
				currentVersion="main@abcdef0"
				upstreamVersion="main@1234567"
			/>,
		);

		expect(markup).toContain('data-testid="settings-gh-repo"');
		expect(markup).toContain('href="https://github.com/JetBrains/thinkrail"');
		expect(markup).toContain('data-testid="settings-gh-repo-current"');
		expect(markup).toContain("main@abcdef0");
		expect(markup).toContain('data-testid="settings-gh-repo-upstream"');
		expect(markup).toContain("main@1234567");
		expect(markup).toContain('data-testid="settings-gh-check-updates"');
	});
});
