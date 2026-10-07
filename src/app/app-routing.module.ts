
import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { MainComponent } from './components/main/main.component';
import { LoginComponent } from './components/auth/login/login.component';
import { RegisterComponent } from './components/auth/register/register.component';
import { SetupComponent } from './components/auth/setup/setup.component';
import { UserManagementComponent } from './components/auth/user-management/user-management.component';
import { AdminGuard, AuthGuard, LoginGuard, SetupGuard } from './services/auth.guard';

const routes: Routes = [
  { path: "setup", loadComponent: () => import('./components/auth/setup/setup.component').then(module => module.SetupComponent), canActivate: [SetupGuard] },
  { path: "login", loadComponent: () => import('./components/auth/login/login.component').then(module => module.LoginComponent), canActivate: [LoginGuard] },
  { path: "register", loadComponent: () => import('./components/auth/register/register.component').then(module => module.RegisterComponent), canActivate: [LoginGuard] },
  { path: "users", loadComponent: () => import('./components/auth/user-management/user-management.component').then(module => module.UserManagementComponent), canActivate: [AdminGuard] },
  { path: "settings", loadComponent: () => import('./components/settings/settings.component').then(module => module.SettingsComponent), canActivate: [AuthGuard] },
  { path: "", component: MainComponent, canActivate: [AuthGuard] },
  { path: "archive", component: MainComponent, canActivate: [AuthGuard] },
  { path: "trash", component: MainComponent, canActivate: [AuthGuard] },
  { path: "reminders", component: MainComponent, canActivate: [AuthGuard] },
  { path: "attachments", component: MainComponent, canActivate: [AuthGuard] },
  { path: "shared", component: MainComponent, canActivate: [AuthGuard] },
  { path: "binder/:name", component: MainComponent, canActivate: [AuthGuard] },
  { path: "label/:name", component: MainComponent, canActivate: [AuthGuard] },
  { path: "**", redirectTo: "" },
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }
