import { Routes } from '@angular/router';
import { UploadPage } from './upload/upload-page';
import { ResultsPage } from './results/results-page';

export const routes: Routes = [
  { path: '', redirectTo: 'upload', pathMatch: 'full' },
  { path: 'upload', component: UploadPage },
  { path: 'runs/:runId', component: ResultsPage },
];
