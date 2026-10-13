import { Injectable, Injector } from '@angular/core';
import { HttpEvent, HttpHandler, HttpInterceptor, HttpRequest } from '@angular/common/http';
import { Observable, catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';

@Injectable()
export class AuthExpiredInterceptor implements HttpInterceptor {
  // AuthService is resolved lazily: it sends requests while it is being constructed, and an interceptor that injected it
  // eagerly would be a dependency cycle that leaves every later request failing with NG0200.
  constructor(private injector: Injector) {}

  intercept(req: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
    return next.handle(req).pipe(catchError(error => {
      if (req.headers.has('Authorization')) this.injector.get(AuthService).notifySessionExpired(error);
      return throwError(() => error);
    }));
  }
}
