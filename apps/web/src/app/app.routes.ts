import type { Routes } from "@angular/router";
import { UploadPage } from "./upload/upload-page";
import { ResultsPage } from "./results/results-page";
import { AdminProvidersPage } from "./admin/admin-providers-page";
import { ReviewBoardPage } from "./review-board/review-board-page";
import { StudentReviewPage } from "./review-board/student-review-page";
import { LoginPage } from "./auth/login-page";
import { requireSession } from "./auth/session.guard";

export const routes: Routes = [
	{ path: "", redirectTo: "upload", pathMatch: "full" },
	{ path: "login", component: LoginPage },
	{ path: "upload", component: UploadPage, canActivate: [requireSession] },
	{ path: "runs/:runId", component: ResultsPage, canActivate: [requireSession] },
	{ path: "review-board", component: ReviewBoardPage, canActivate: [requireSession] },
	{
		path: "students/:studentId/review",
		component: StudentReviewPage,
		canActivate: [requireSession],
	},
	{
		path: "admin/llm-providers",
		component: AdminProvidersPage,
		canActivate: [requireSession],
	},
];
