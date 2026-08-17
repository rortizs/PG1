export interface ReportArtifact {
	readonly id: string;
	readonly kind?: string | null;
	readonly filename?: string | null;
	readonly content_type?: string | null;
	readonly content?: string | null;
}

export interface MarkdownReportDownload {
	readonly filename: string;
	readonly content: string;
	readonly contentType: "text/markdown;charset=utf-8";
}

export function selectMarkdownReportArtifact(
	artifacts: readonly ReportArtifact[],
): ReportArtifact | null {
	return (
		artifacts.find((artifact) => {
			const contentType = artifact.content_type?.toLowerCase() ?? "";
			return (
				artifact.kind === "markdown" || contentType.startsWith("text/markdown")
			);
		}) ?? null
	);
}

export function buildMarkdownReportDownload(
	artifact: ReportArtifact | null,
): MarkdownReportDownload | null {
	if (!artifact?.content) return null;
	return {
		filename: withMarkdownExtension(artifact.filename || "review-report.md"),
		content: artifact.content,
		contentType: "text/markdown;charset=utf-8",
	};
}

function withMarkdownExtension(filename: string): string {
	return filename.toLowerCase().endsWith(".md") ? filename : `${filename}.md`;
}
