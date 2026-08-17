import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildMarkdownReportDownload,
	selectMarkdownReportArtifact,
} from "../src/app/results/report-download-view.ts";

const artifact = (id, kind, contentType, filename, content = "# Report") => ({
	id,
	kind,
	filename,
	content_type: contentType,
	content,
});

test("selects the first markdown report artifact by kind or content type", () => {
	const artifacts = [
		artifact("json-report", "json", "application/json", "report.json", "{}"),
		artifact("markdown-report", "markdown", "text/plain", "review-summary.md"),
		artifact(
			"markdown-by-type",
			"artifact",
			"text/markdown; charset=utf-8",
			"fallback.md",
		),
	];

	assert.equal(selectMarkdownReportArtifact(artifacts)?.id, "markdown-report");
});

test("returns null when no markdown artifact is ready", () => {
	assert.equal(
		selectMarkdownReportArtifact([
			artifact("json-report", "json", "application/json", "report.json"),
		]),
		null,
	);
});

test("builds markdown download metadata with a safe filename and blob type", () => {
	assert.deepEqual(
		buildMarkdownReportDownload(
			artifact(
				"markdown-report",
				"artifact",
				"text/markdown; charset=utf-8",
				"review-summary",
			),
		),
		{
			filename: "review-summary.md",
			content: "# Report",
			contentType: "text/markdown;charset=utf-8",
		},
	);
});
