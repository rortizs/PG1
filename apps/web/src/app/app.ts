import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * Real Angular standalone root shell for the PG1 web app.
 *
 * Route content (upload page, results page) is rendered through
 * `<router-outlet />`; see `app.routes.ts`.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<router-outlet />`,
})
export class App {}
