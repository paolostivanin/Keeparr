import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, OnInit } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthService } from 'src/app/services/auth.service';
import { environment } from 'src/environments/environment';

interface UpdateInfo {
  latest: string | null;
  isOutdated: boolean;
  releaseUrl: string | null;
  checkedAt: string | null;
  checkError: string | null;
}

/** Version, attribution, licence and credits. The update status rows are only loaded for admins. */
@Component({
  selector: 'app-about',
  templateUrl: './about.component.html',
  styleUrls: ['./about.component.scss'],
  standalone: true,
  imports: [CommonModule]
})
export class AboutComponent implements OnInit {
  readonly sourceUrl = 'https://github.com/paolostivanin/Keeparr';
  readonly upstreamUrl = 'https://github.com/ericerkz/kept';
  readonly licenseUrl = 'https://github.com/paolostivanin/Keeparr/blob/main/LICENSE';
  readonly scaffoldUrl = 'https://github.com/aBrihoum/google-keep-clone';

  version: string | null = null;
  update: UpdateInfo | null = null;

  constructor(private http: HttpClient, private auth: AuthService) { }

  async ngOnInit() {
    const headers = this.auth.authHeaders();
    try {
      const capabilities: any = await firstValueFrom(this.http.get(`${environment.apiUrl}/client/capabilities`, { headers }));
      this.version = capabilities?.serverVersion ?? null;
    } catch {
      this.version = null;
    }
    if (!this.auth.isAdmin) return;
    try {
      const data: any = await firstValueFrom(this.http.get(`${environment.apiUrl}/admin/update-status`, { headers }));
      this.version = data.current ?? this.version;
      this.update = {
        latest: data.latest,
        isOutdated: !!data.isOutdated,
        releaseUrl: data.releaseUrl,
        checkedAt: data.checkedAt,
        checkError: data.checkError
      };
    } catch {
      this.update = null;
    }
  }
}
