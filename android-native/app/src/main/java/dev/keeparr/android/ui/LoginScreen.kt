package dev.keeparr.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.keeparr.android.KeeparrApplication
import dev.keeparr.android.MainActivity
import dev.keeparr.android.data.ConnectionProfilePolicy
import dev.keeparr.android.data.SecondFactorRequired
import dev.keeparr.android.data.text
import dev.keeparr.android.ui.components.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONObject

private data class PendingLogin(val origin: String, val headers: String, val response: JSONObject)

/** Sign-in is two steps when the account uses 2FA: the code is asked for only once the server says it is needed. */
private enum class LoginStep { Credentials, SecondFactor }

/** The server's lengths: an authenticator code is 6 digits, a backup code 8 letters and digits (case does not matter). */
private const val AUTHENTICATOR_CODE_LENGTH = 6
private const val BACKUP_CODE_LENGTH = 8

/** Gateway headers are optional, but when present they must be a JSON object. */
private fun headersValid(headers: String) = headers.isBlank() || runCatching { JSONObject(headers) }.isSuccess

@Composable
internal fun LoginScreen(activity: MainActivity, app: KeeparrApplication, onLogin: () -> Unit, onCancel: () -> Unit) {
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    var server by rememberSaveable { mutableStateOf(app.settings.origin) }
    var username by rememberSaveable { mutableStateOf("") }
    // Secrets stay out of the saved instance state.
    var password by remember { mutableStateOf("") }
    var totp by remember { mutableStateOf("") }
    var certificate by remember { mutableStateOf(app.settings.aliasFor(server)) }
    var headers by remember { mutableStateOf(app.settings.headersFor(server)) }
    var connectionStatus by remember { mutableStateOf<String?>(null) }
    var testing by remember { mutableStateOf(false) }
    var signingIn by remember { mutableStateOf(false) }
    var signInError by remember { mutableStateOf<String?>(null) }
    var pendingLogin by remember { mutableStateOf<PendingLogin?>(null) }
    // Not saved: the password lives only in memory, so a re-created screen starts again from the credentials.
    var step by remember { mutableStateOf(LoginStep.Credentials) }
    var useBackupCode by remember { mutableStateOf(false) }
    var codeError by remember { mutableStateOf<String?>(null) }
    // Most servers need neither, so they stay folded away unless one is already set.
    var advanced by rememberSaveable { mutableStateOf(certificate.isNotBlank() || headers.isNotBlank()) }
    val headersOk = headersValid(headers)
    val canSignIn = !signingIn && !testing && server.isNotBlank() && username.isNotBlank() && password.isNotBlank() && headersOk
    suspend fun activate(login: PendingLogin) {
        app.settings.activateSession(
            login.origin,
            login.headers,
            login.response.getString("token"),
            login.response.getJSONObject("user").getLong("id")
        )
        pendingLogin = null
        onLogin()
    }
    /** Sends the credentials, with [code] on the second step; a server asking for a code moves on to that step. */
    fun submit(code: String) {
        if (signingIn) return
        focus.clearFocus()
        scope.launch {
            signingIn = true
            signInError = null
            codeError = null
            try {
                val response = app.repository.api.login(server, username, password, code, headers)
                val targetOrigin = server.trim().trimEnd('/')
                val target = PendingLogin(targetOrigin, headers, response)
                val targetUserId = response.getJSONObject("user").getLong("id")
                if (ConnectionProfilePolicy.requiresConfirmation(app.settings.snapshot(), targetOrigin, targetUserId)) pendingLogin = target
                else activate(target)
            } catch (cancelled: CancellationException) { throw cancelled
            } catch (_: SecondFactorRequired) { totp = ""; useBackupCode = false; step = LoginStep.SecondFactor
            } catch (problem: Exception) {
                val message = problem.message ?: "Sign-in failed"
                // A rejected code is cleared so the next one can be typed straight away; the reason stays until then.
                if (step == LoginStep.SecondFactor) { codeError = message; totp = "" } else signInError = message
            } finally { signingIn = false }
        }
    }
    fun signIn() { if (canSignIn) submit("") }
    fun backToCredentials() { step = LoginStep.Credentials; totp = ""; codeError = null }
    BackHandler(enabled = step == LoginStep.SecondFactor, onBack = ::backToCredentials)
    Scaffold(snackbarHost = { KeeparrSnackbarHost() }, contentWindowInsets = WindowInsets.safeDrawing) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).verticalScroll(rememberScrollState()),
            contentAlignment = Alignment.TopCenter) {
            Column(Modifier.widthIn(max = Dimens.formMaxWidth).fillMaxWidth().padding(horizontal = Spacing.xl, vertical = Spacing.xl),
                verticalArrangement = Arrangement.spacedBy(Spacing.lg)) {
                BrandMark(56.dp, Modifier.padding(top = Spacing.lg))
                AnimatedContent(step, transitionSpec = {
                    val direction = if (targetState == LoginStep.SecondFactor) 1 else -1
                    (fadeIn(tween(Motion.ENTER)) + slideInHorizontally(tween(Motion.SLOW, easing = Motion.EmphasizedDecelerate)) { it / 8 * direction }) togetherWith
                        fadeOut(tween(Motion.EXIT))
                }, label = "sign-in step") { current ->
                if (current == LoginStep.SecondFactor) SecondFactorStep(username, server, totp, onCodeChange = { value ->
                    val length = if (useBackupCode) BACKUP_CODE_LENGTH else AUTHENTICATOR_CODE_LENGTH
                    val code = (if (useBackupCode) value.filter(Char::isLetterOrDigit).uppercase() else value.filter(Char::isDigit)).take(length)
                    totp = code
                    codeError = null
                    // A complete authenticator code goes straight away, as on other sign-in screens; a backup code waits for Verify.
                    if (!useBackupCode && code.length == length && !signingIn) submit(code)
                }, backupCode = useBackupCode, onToggleBackupCode = { useBackupCode = !useBackupCode; totp = ""; codeError = null },
                    error = codeError, verifying = signingIn, onVerify = { submit(totp) }, onBack = ::backToCredentials)
                else Column(verticalArrangement = Arrangement.spacedBy(Spacing.lg)) {
                Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    Text("Your notes. Your server.", style = MaterialTheme.typography.headlineMedium)
                    Text("Sign in to your Keeparr server", style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                app.settings.message.takeIf { it.isNotBlank() }?.let { StatusBanner(it, tone = BannerTone.Warning) }

                SectionHeader("Server", Modifier.padding(top = Spacing.sm))
                OutlinedTextField(server, { value ->
                    server = value
                    certificate = app.settings.aliasFor(value)
                    headers = app.settings.headersFor(value)
                    connectionStatus = null
                }, label = { Text("Server address") }, placeholder = { Text("https://notes.example.com") },
                    leadingIcon = { Icon(Icons.Outlined.Dns, null) }, modifier = Modifier.fillMaxWidth(), singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false, imeAction = ImeAction.Next),
                    keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }))
                OutlinedButton(onClick = { scope.launch {
                    testing = true
                    connectionStatus = null
                    try { connectionStatus = app.repository.api.testConnection(server, headers) }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (problem: Exception) { connectionStatus = problem.message ?: "Connection test failed" }
                    finally { testing = false }
                } }, enabled = !testing && !signingIn && server.isNotBlank() && headersOk, modifier = Modifier.fillMaxWidth().heightIn(min = Dimens.minTouchTarget)) {
                    if (testing) CircularProgressIndicator(Modifier.size(Dimens.iconSmall), strokeWidth = 2.dp)
                    else Icon(Icons.Outlined.NetworkCheck, null, Modifier.size(Dimens.iconSmall))
                    Spacer(Modifier.width(Spacing.sm))
                    Text(if (testing) "Testing connection…" else "Test connection")
                }
                connectionStatus?.let {
                    StatusBanner(it, tone = if (it.startsWith("Connected")) BannerTone.Success else BannerTone.Error)
                }
                AdvancedConnection(advanced, onToggle = { advanced = !advanced }) {
                    Text("Only needed when the server sits behind a gateway that asks for a client certificate or extra headers.",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    OutlinedButton(onClick = { activity.chooseCertificate(server) { certificate = it } }, modifier = Modifier.fillMaxWidth()) {
                        Icon(Icons.Outlined.VerifiedUser, null, Modifier.size(Dimens.iconSmall)); Spacer(Modifier.width(Spacing.sm))
                        Text(if (certificate.isBlank()) "Choose client certificate" else "Certificate: $certificate")
                    }
                    if (certificate.isNotBlank()) TextButton(onClick = { certificate = ""; app.settings.setAliasFor(server, "") }) {
                        Text("Use no client certificate")
                    }
                    OutlinedTextField(headers, { headers = it }, label = { Text("Gateway headers (JSON)") },
                        placeholder = { Text("{\"X-Header\": \"value\"}") }, isError = !headersOk,
                        supportingText = { Text(if (headersOk) "Optional. Sent with every request." else "Enter a JSON object, or leave this empty.") },
                        modifier = Modifier.fillMaxWidth(), minLines = 2,
                        keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Ascii))
                }

                SectionHeader("Account", Modifier.padding(top = Spacing.sm))
                OutlinedTextField(username, { username = it }, label = { Text("Username") }, leadingIcon = { Icon(Icons.Outlined.Person, null) },
                    modifier = Modifier.fillMaxWidth(), singleLine = true,
                    keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, capitalization = KeyboardCapitalization.None, imeAction = ImeAction.Next),
                    keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }))
                PasswordField(password, { password = it }, "Password", Modifier.fillMaxWidth(), imeAction = ImeAction.Done,
                    onImeAction = ::signIn, leadingIcon = Icons.Outlined.Key,
                    supportingText = "If your account uses two-step verification, you'll be asked for a code next.")
                signInError?.let { StatusBanner(it, tone = BannerTone.Error, title = "Couldn't sign in") }
                Button(onClick = ::signIn, enabled = canSignIn, modifier = Modifier.fillMaxWidth().heightIn(min = Dimens.minTouchTarget)) {
                    if (signingIn) {
                        CircularProgressIndicator(Modifier.size(Dimens.iconSmall), strokeWidth = 2.dp, color = LocalContentColor.current)
                        Spacer(Modifier.width(Spacing.sm))
                        Text("Signing in…")
                    } else Text("Sign in")
                }
                }
                }
            }
        }
    }
    pendingLogin?.let { login ->
        val user = login.response.getJSONObject("user")
        val displayName = user.text("displayName", user.text("username", "this account"))
        var switchError by remember(login) { mutableStateOf<String?>(null) }
        var switching by remember(login) { mutableStateOf(false) }
        ConfirmDialog(title = "Switch Keeparr profile?",
            text = "Sign in as $displayName on ${login.origin}? Your cached notes and pending work stay isolated in the previous profile.",
            confirmLabel = "Switch profile", dismissLabel = "Stay with previous profile", icon = Icons.Outlined.SwitchAccount,
            error = switchError, busy = switching,
            onConfirm = { scope.launch {
                switching = true
                try { activate(login) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (problem: Exception) { switchError = problem.message ?: "Could not activate this profile" }
                finally { switching = false }
            } },
            onDismiss = { pendingLogin = null; onCancel() })
    }
}

/**
 * The second sign-in step: the code from an authenticator app (6 digits, sent as soon as it is complete) or one of the account's
 * backup codes (8 characters). Stateless, so the screen above owns the code and the request.
 */
@Composable
internal fun SecondFactorStep(username: String, server: String, code: String, onCodeChange: (String) -> Unit, backupCode: Boolean,
    onToggleBackupCode: () -> Unit, error: String?, verifying: Boolean, onVerify: () -> Unit, onBack: () -> Unit) {
    val focusRequester = remember { FocusRequester() }
    // Focused on arrival and whenever the kind of code changes, so the right keyboard is already up.
    LaunchedEffect(backupCode) { focusRequester.requestFocus() }
    val length = if (backupCode) BACKUP_CODE_LENGTH else AUTHENTICATOR_CODE_LENGTH
    val host = remember(server) { android.net.Uri.parse(server.trim()).host ?: server.trim() }
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.lg)) {
        Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            Text("Two-step verification", Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineMedium)
            Text(if (backupCode) "Enter one of your backup codes for $username. Each code works once."
                else "Enter the 6-digit code from your authenticator app for $username" + (if (host.isNotBlank()) " on $host." else "."),
                style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        OutlinedTextField(code, onCodeChange, Modifier.fillMaxWidth().focusRequester(focusRequester),
            label = { Text(if (backupCode) "Backup code" else "Authenticator code") },
            leadingIcon = { Icon(if (backupCode) Icons.Outlined.Password else Icons.Outlined.Pin, null) },
            textStyle = MaterialTheme.typography.titleLarge.copy(letterSpacing = 4.sp), singleLine = true, enabled = !verifying,
            isError = error != null, supportingText = { Text(error ?: "${code.length} / $length") },
            keyboardOptions = if (backupCode) KeyboardOptions(keyboardType = KeyboardType.Ascii, capitalization = KeyboardCapitalization.Characters,
                autoCorrectEnabled = false, imeAction = ImeAction.Done)
                else KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { if (code.length == length) onVerify() }))
        Button(onClick = onVerify, enabled = !verifying && code.length == length, modifier = Modifier.fillMaxWidth().heightIn(min = Dimens.minTouchTarget)) {
            if (verifying) {
                CircularProgressIndicator(Modifier.size(Dimens.iconSmall), strokeWidth = 2.dp, color = LocalContentColor.current)
                Spacer(Modifier.width(Spacing.sm))
                Text("Verifying…")
            } else Text("Verify")
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack, enabled = !verifying) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, null, Modifier.size(Dimens.iconSmall)); Spacer(Modifier.width(Spacing.sm))
                Text("Back")
            }
            TextButton(onClick = onToggleBackupCode, enabled = !verifying) {
                Text(if (backupCode) "Use authenticator code" else "Use a backup code")
            }
        }
    }
}

/** The fold-out holding the client certificate and gateway headers. */
@Composable
private fun AdvancedConnection(expanded: Boolean, onToggle: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val rotation by animateFloatAsState(if (expanded) 180f else 0f, label = "advanced arrow")
    Column {
        Row(Modifier.fillMaxWidth().heightIn(min = Dimens.minTouchTarget).clip(MaterialTheme.shapes.chip)
            .clickable(role = Role.Button, onClickLabel = if (expanded) "Hide advanced options" else "Show advanced options", onClick = onToggle)
            .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }
            .padding(horizontal = Spacing.xs),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
            Icon(Icons.Outlined.Tune, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("Advanced connection options", Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
            Icon(Icons.Outlined.ExpandMore, null, Modifier.rotate(rotation), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        AnimatedVisibility(expanded) {
            Column(Modifier.padding(top = Spacing.sm), verticalArrangement = Arrangement.spacedBy(Spacing.md), content = content)
        }
    }
}
