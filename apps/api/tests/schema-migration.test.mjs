import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

const migrationUrl = new URL(
	"../src/db/migrations/0001_schema_baseline.sql",
	import.meta.url,
);

const REQUIRED_TABLES = [
	"thesis_document",
	"review_run",
	"document_page",
	"document_section",
	"evidence_snippet",
	"finding",
	"finding_evidence",
	"report_artifact",
	"normative_source",
	"normative_segment",
	"embedding_record",
	"audit_event",
];

async function migrationSql() {
	return readFile(migrationUrl, "utf8");
}

test("schema migration creates pgvector extension and required tables", async () => {
	const sql = await migrationSql();

	assert.match(sql, /CREATE EXTENSION IF NOT EXISTS vector;/i);
	for (const table of REQUIRED_TABLES) {
		assert.match(sql, new RegExp(`CREATE TABLE ${table}\\s*\\(`, "i"));
	}
});

test("schema migration uses PostgreSQL-safe identity ids, timestamptz, and snake_case", async () => {
	const sql = await migrationSql();

	assert.doesNotMatch(sql, /\bSERIAL\b/i);
	assert.doesNotMatch(sql, /\bVARCHAR\b/i);
	assert.doesNotMatch(sql, /\bTIMESTAMP\b(?!\s+WITH\s+TIME\s+ZONE)/i);
	assert.match(sql, /id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY/i);
	assert.match(sql, /created_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/i);
	assert.doesNotMatch(sql, /"[A-Za-z]+[A-Z][A-Za-z]*"/);
});

test("schema migration enforces statuses, non-empty evidence, and jsonb object metadata", async () => {
	const sql = await migrationSql();

	assert.match(
		sql,
		/review_run_status_check[\s\S]*queued[\s\S]*extracting[\s\S]*cancelled/i,
	);
	assert.match(
		sql,
		/finding_status_check[\s\S]*valid[\s\S]*rejected[\s\S]*quarantined[\s\S]*partial/i,
	);
	assert.match(sql, /CHECK \(btrim\(evidence_text\) <> ''\)/i);
	assert.match(sql, /CHECK \(jsonb_typeof\(metadata\) = 'object'\)/i);
});

test("schema migration defines normalized foreign keys and explicit FK indexes", async () => {
	const sql = await migrationSql();

	const foreignKeys = [
		"thesis_document_id BIGINT NOT NULL REFERENCES thesis_document(id)",
		"review_run_id BIGINT NOT NULL REFERENCES review_run(id)",
		"document_page_id BIGINT REFERENCES document_page(id)",
		"document_section_id BIGINT REFERENCES document_section(id)",
		"normative_source_id BIGINT REFERENCES normative_source(id)",
		"normative_source_id BIGINT NOT NULL REFERENCES normative_source(id)",
		"finding_id BIGINT NOT NULL REFERENCES finding(id)",
		"evidence_snippet_id BIGINT NOT NULL REFERENCES evidence_snippet(id)",
	];

	for (const fk of foreignKeys) {
		assert.match(sql, new RegExp(fk.replace(/[()]/g, "\\$&"), "i"));
	}

	const indexes = [
		"idx_review_run_thesis_document_id",
		"idx_document_page_review_run_id",
		"idx_document_section_parent_section_id",
		"idx_evidence_snippet_document_page_id",
		"idx_finding_normative_source_id",
		"idx_finding_evidence_evidence_snippet_id",
		"idx_report_artifact_review_run_format",
		"idx_normative_segment_normative_source_id",
		"idx_embedding_record_source_class_source_id",
		"idx_audit_event_entity_type_entity_id",
	];

	for (const index of indexes) {
		assert.match(sql, new RegExp(`CREATE INDEX ${index}`, "i"));
	}
});

test("schema migration constrains embeddings to normative segments", async () => {
	const sql = await migrationSql();

	assert.match(
		sql,
		/source_class TEXT NOT NULL CHECK \(source_class IN \('normative_segment'\)\)/i,
	);
	assert.match(
		sql,
		/source_id BIGINT NOT NULL REFERENCES normative_segment\(id\)/i,
	);
});

test("schema migration includes down migration drops in dependency-safe order", async () => {
	const sql = await migrationSql();

	assert.match(sql, /-- DOWN/i);
	assert.match(sql, /DROP TABLE IF EXISTS audit_event;/i);
	assert.match(sql, /DROP TABLE IF EXISTS thesis_document;/i);
	assert.match(sql, /DROP EXTENSION IF EXISTS vector;/i);
});
