import type { Routes } from "@angular/router";
import { UploadPage } from "./upload/upload-page";
import { ResultsPage } from "./results/results-page";
import { AdminProvidersPage } from "./admin/admin-providers-page";
import { ReviewBoardPage } from "./review-board/review-board-page";
import { StudentReviewPage } from "./review-board/student-review-page";

export const routes: Routes = [
	{ path: "", redirectTo: "upload", pathMatch: "full" },
	{ path: "upload", component: UploadPage },
	{ path: "runs/:runId", component: ResultsPage },
	{ path: "review-board", component: ReviewBoardPage },
	{ path: "students/:studentId/review", component: StudentReviewPage },
	{ path: "admin/llm-providers", component: AdminProvidersPage },
];
