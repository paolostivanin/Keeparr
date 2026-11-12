@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package dev.keeparr.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.staggeredgrid.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Label
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.max
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.keeparr.android.KeeparrApplication
import dev.keeparr.android.data.*
import dev.keeparr.android.data.html.NoteHtml
import dev.keeparr.android.ui.components.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * The note list: search, the drawer of views, the grid (or list) of note cards, selection and reordering, reminders, and
 * creation. Its view, query, layout, scroll position and last projection are owned by [home] and [gridState], which outlive
 * this screen while a note or Settings is open. [notes] is null until the database has answered.
 */
@Composable
internal fun HomeScreen(app: KeeparrApplication, home: HomeState, gridState: LazyStaggeredGridState, notes: List<Note>?,
    reminders: List<JSONObject>, conflicts: List<Outbox>, onEdit: (Note) -> Unit, onCreate: (Boolean) -> Unit, onSettings: () -> Unit,
    onReauthenticate: () -> Unit, onError: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    val connectionState by app.repository.connectionState.collectAsStateWithLifecycle()
    val moveCompleted by app.settings.moveCompletedToBottom.collectAsStateWithLifecycle()
    LaunchedEffect(home, notes, home.filter, home.search, reminders, moveCompleted) {
        val loaded = notes ?: return@LaunchedEffect
        home.projection = withContext(Dispatchers.Default) { home.projector.project(loaded, home.filter, home.search, reminders, moveCompleted) }
        home.projected = true
    }
    val projection = home.projection
    val visible = projection.visibleNotes
    val selectedIds = home.selectedIds
    val reorderEnabled = home.reorderEnabled
    var confirmBulkTrash by remember { mutableStateOf(false) }
    var conflict by remember { mutableStateOf<Outbox?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    val drawer = rememberDrawerState(DrawerValue.Closed)
    // Plain holders: geometry and the latest projection are read by gestures at drag time, never during composition.
    val latestProjection by rememberUpdatedState(projection)
    val gridCoordinates = remember { arrayOfNulls<LayoutCoordinates>(1) }
    val reorder = remember { NoteReorderController { source, target ->
        val byId = latestProjection.notesBySyncId
        byId[source] != null && byId[source]?.pinned == byId[target]?.pinned
    } }
    val visibleIndex = remember(visible) { visible.withIndex().associate { it.value.syncId to it.index } }
    fun moveNote(syncId: String, delta: Int) = visibleIndex[syncId]?.let { moveNoteBy(visible, it, delta) }
    val selectedNotes = selectedIds.mapNotNull(projection.notesBySyncId::get)
    val canTrashSelected = selectedNotes.isNotEmpty() && selectedNotes.all { it.owner == app.settings.userId }
    val allSelectedTrashed = selectedNotes.isNotEmpty() && selectedNotes.all { it.trashed }
    val action = rememberActionRunner(onError)
    // A failed manual sync is reported by the status banner (the repository records why), so it needs no message of its own.
    fun refresh() {
        if (refreshing) return
        refreshing = true
        scope.launch {
            try { app.repository.sync() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) {}
            finally { refreshing = false }
        }
    }
    // Back unwinds the screen's own state before leaving the app: the drawer (handled by its sheet), the selection, the
    // query, then the view.
    BackHandler(enabled = !drawer.isOpen && (home.selecting || home.search.isNotEmpty() || home.filter != "home")) {
        when {
            home.selecting -> home.clearSelection()
            home.search.isNotEmpty() -> home.search = ""
            else -> home.filter = "home"
        }
    }
    // Note counts for the drawer, from the same filter the views use, so a badge always matches what its view shows.
    // Reminders has none: it lists reminders, not notes.
    var drawerCounts by remember { mutableStateOf(emptyMap<String, Int>()) }
    LaunchedEffect(notes, projection.filterChoices) {
        val loaded = notes ?: return@LaunchedEffect
        val keys = projection.filterChoices.map { it.first }.filter { it != "reminders" }
        drawerCounts = withContext(Dispatchers.Default) { keys.associateWith { NoteOrder.visible(loaded, it).size } }
    }
    val server = remember(app.settings.origin) { android.net.Uri.parse(app.settings.origin).host ?: app.settings.origin }
    ModalNavigationDrawer(drawerState = drawer, drawerContent = {
        HomeDrawer(drawer, projection.filterChoices, drawerCounts, server, home.filter, onSelect = { value ->
            home.filter = value
            scope.launch { drawer.close() }
        }, onSettings = { scope.launch { drawer.close() }; onSettings() })
    }) {
        Scaffold(topBar = {
            Column(Modifier.statusBarsPadding().padding(horizontal = Spacing.md).padding(top = Spacing.sm, bottom = Spacing.xs)
                .centeredMaxWidth(), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                // While leaving selection mode the bar fades out showing the selection it had, not "0 selected".
                val shownSelection = remember { arrayOf(emptySet<String>()) }.also { if (selectedIds.isNotEmpty()) it[0] = selectedIds }[0]
                AnimatedContent(home.selecting, transitionSpec = { fadeIn(tween(Motion.BASE)) togetherWith fadeOut(tween(Motion.EXIT)) },
                    label = "home top bar") { selecting ->
                    if (selecting) SelectionBar(shownSelection.size, canTrash = canTrashSelected, trashed = allSelectedTrashed,
                        earlier = if (shownSelection.size == 1 && reorderEnabled) moveNote(shownSelection.single(), -1) else null,
                        later = if (shownSelection.size == 1 && reorderEnabled) moveNote(shownSelection.single(), 1) else null,
                        showMoves = shownSelection.size == 1 && reorderEnabled,
                        onMove = { ids -> action { app.repository.reorder(ids) } },
                        onTrash = {
                            if (allSelectedTrashed) action { app.repository.setTrashed(selectedIds.toList(), false); home.clearSelection() }
                            else confirmBulkTrash = true
                        },
                        onClear = home::clearSelection)
                    else SearchPill(home.search, onSearch = { home.search = it }, grid = home.grid, onToggleGrid = { home.grid = !home.grid },
                        onMenu = { scope.launch { drawer.open() } }, onSettings = onSettings)
                }
                SyncStatus(connectionState, conflicts.size, onReauthenticate = onReauthenticate, onRetry = ::refresh,
                    onReview = { conflict = conflicts.firstOrNull() })
            }
        }, bottomBar = {
            // Notes are not created from Trash: a new note would not belong to the view it was made in.
            if (home.filter != "trash") BottomAppBar(actions = {
                IconButton(onClick = { onCreate(true) }) { Icon(Icons.Outlined.CheckBox, "New checklist") }
            }, floatingActionButton = {
                // The one brand-yellow control on the screen: creating a note is the primary action.
                FloatingActionButton(onClick = { onCreate(false) }, containerColor = MaterialTheme.extendedColors.brand,
                    contentColor = MaterialTheme.extendedColors.onBrand, elevation = FloatingActionButtonDefaults.bottomAppBarFabElevation()) {
                    Icon(Icons.Outlined.Add, "New note")
                }
            })
        }, snackbarHost = { KeeparrSnackbarHost() }) { padding ->
            val content = Modifier.fillMaxSize().padding(padding)
            if (notes == null || !home.projected) LoadingState(content)
            else PullToRefreshBox(isRefreshing = refreshing, onRefresh = ::refresh, modifier = content) {
                val header: (@Composable () -> Unit)? = viewTitle(home.filter, projection.filterChoices)?.let { (title, hint) ->
                    { ViewHeader(title, hint) }
                }
                if (home.filter == "reminders") ReminderList(app, reminders, notes, header, Modifier.fillMaxSize(),
                    onOpenNote = onEdit, onError = onError)
                else if (visible.isEmpty()) Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).centeredMaxWidth()
                    .padding(horizontal = Spacing.md)) {
                    header?.invoke()
                    Box(Modifier.fillMaxWidth().padding(top = 48.dp), contentAlignment = Alignment.Center) {
                        emptyView(home.filter, home.search).let { EmptyState(it.icon, it.title, it.hint) }
                    }
                }
                else BoxWithConstraints(Modifier.fillMaxSize()) {
                    // List mode reads as one column; on a wide screen it stays at a readable width in the middle.
                    val side = if (home.grid) Spacing.md else max(Spacing.md, (maxWidth - Dimens.contentMaxWidth) / 2)
                    // With a large font size, columns widen so cards don't turn into narrow strips (a phone drops to one column).
                    val fontScale = LocalDensity.current.fontScale
                    val minColumn = if (fontScale > 1.3f) Dimens.noteMinColumn * fontScale else Dimens.noteMinColumn
                    LazyVerticalStaggeredGrid(columns = if (home.grid) StaggeredGridCells.Adaptive(minColumn) else StaggeredGridCells.Fixed(1),
                        state = gridState,
                        modifier = Modifier.fillMaxSize().onGloballyPositioned { gridCoordinates[0] = it }
                            .noteReorderGestures(reorder, reorderEnabled, { gridCoordinates[0] }, { gridState.scrollBy(it) }, onDrop = { drop ->
                                val source = latestProjection.notesBySyncId[drop.sourceId]
                                if (source != null && selectedIds.size <= 1) moveDraggedNote(visible, source, drop.targetId)?.let { ids -> action { app.repository.reorder(ids) } }
                            }),
                        contentPadding = PaddingValues(start = side, end = side, top = Spacing.xs, bottom = Spacing.xl),
                        horizontalArrangement = Arrangement.spacedBy(Dimens.gridGutter), verticalItemSpacing = Dimens.gridGutter) {
                        if (header != null) item(span = StaggeredGridItemSpan.FullLine, contentType = "view-header") { header() }
                        val pinned = projection.pinnedCards; val other = projection.otherCards
                        @Composable fun Card(card: NoteCardUiModel, modifier: Modifier) = NoteCard(app, card, modifier, card.syncId in selectedIds,
                            selecting = selectedIds.isNotEmpty(), reorderEnabled = reorderEnabled, reorder = reorder,
                            onClick = { if (selectedIds.isEmpty()) projection.notesBySyncId[card.syncId]?.let(onEdit) else home.toggle(card.syncId) },
                            onLongClick = { home.select(card.syncId) },
                            onMove = { delta -> moveNote(card.syncId, delta)?.let { ids -> action { app.repository.reorder(ids) } } },
                            canMove = { delta -> visibleIndex[card.syncId]?.let { canMoveNoteBy(visible, it, delta) } == true })
                        if (pinned.isNotEmpty()) item(span = StaggeredGridItemSpan.FullLine, contentType = "section-header") { GridSectionHeader("Pinned") }
                        items(pinned, key = { it.syncId }, contentType = { it.contentType }) { card -> Card(card, Modifier.animateItem(fadeOutSpec = tween(Motion.BASE))) }
                        if (pinned.isNotEmpty() && other.isNotEmpty()) item(span = StaggeredGridItemSpan.FullLine, contentType = "section-header") { GridSectionHeader("Others") }
                        items(other, key = { it.syncId }, contentType = { it.contentType }) { card -> Card(card, Modifier.animateItem(fadeOutSpec = tween(Motion.BASE))) }
                    }
                }
            }
        }
    }
    conflict?.let { entry -> ConflictDialog(app, entry, onDismiss = { conflict = null }) }
    if (confirmBulkTrash) {
        var trashError by remember { mutableStateOf<String?>(null) }
        var trashing by remember { mutableStateOf(false) }
        val dialogAction = rememberActionRunner { trashError = it; trashing = false }
        val count = selectedIds.size
        ConfirmDialog(title = if (count == 1) "Move note to Trash?" else "Move $count notes to Trash?",
            text = "You can restore them from Trash later.", confirmLabel = "Move to Trash", icon = Icons.Outlined.DeleteOutline,
            error = trashError, busy = trashing,
            onConfirm = {
                trashing = true
                dialogAction {
                    app.repository.setTrashed(selectedIds.toList(), true)
                    home.clearSelection()
                    confirmBulkTrash = false
                }
            },
            onDismiss = { confirmBulkTrash = false })
    }
}

/** The pill at the top of the home screen: drawer, search, layout toggle and Settings. */
@Composable
private fun SearchPill(search: String, onSearch: (String) -> Unit, grid: Boolean, onToggleGrid: () -> Unit, onMenu: () -> Unit, onSettings: () -> Unit) {
    val focus = LocalFocusManager.current
    // Grows with the font size instead of clipping it; a bare text field, since a Material TextField's own padding does not fit a pill.
    Surface(Modifier.fillMaxWidth().heightIn(min = Dimens.searchBarHeight), shape = MaterialTheme.shapes.pill,
        color = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Row(Modifier.padding(horizontal = Spacing.xs), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onMenu) { Icon(Icons.Outlined.Menu, "Open navigation") }
            val textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface)
            BasicTextField(search, onSearch, Modifier.weight(1f).padding(horizontal = Spacing.xs, vertical = Spacing.md),
                singleLine = true, textStyle = textStyle,
                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = { focus.clearFocus() }),
                decorationBox = { inner -> Box(contentAlignment = Alignment.CenterStart) {
                    if (search.isEmpty()) Text("Search your notes", style = textStyle, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    inner()
                } })
            if (search.isNotEmpty()) IconButton(onClick = { onSearch("") }) { Icon(Icons.Outlined.Close, "Clear search") }
            IconButton(onClick = onToggleGrid) {
                Icon(if (grid) Icons.Outlined.ViewAgenda else Icons.Outlined.GridView, if (grid) "Show as list" else "Show as grid")
            }
            IconButton(onClick = onSettings) { Icon(Icons.Outlined.AccountCircle, "Account and settings") }
        }
    }
}

/** Replaces the search pill while notes are selected. */
@Composable
private fun SelectionBar(count: Int, canTrash: Boolean, trashed: Boolean, showMoves: Boolean, earlier: List<String>?, later: List<String>?,
    onMove: (List<String>) -> Unit, onTrash: () -> Unit, onClear: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        Surface(Modifier.fillMaxWidth().heightIn(min = Dimens.searchBarHeight), shape = MaterialTheme.shapes.pill,
            color = MaterialTheme.colorScheme.secondaryContainer) {
            Row(Modifier.padding(horizontal = Spacing.xs), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onClear) { Icon(Icons.Outlined.Close, "Clear selection") }
                Text("$count selected", Modifier.weight(1f).padding(start = Spacing.xs).semantics { heading() },
                    style = MaterialTheme.typography.titleMedium)
                if (showMoves) {
                    IconButton(onClick = { earlier?.let(onMove) }, enabled = earlier != null) { Icon(Icons.Outlined.ArrowUpward, "Move earlier") }
                    IconButton(onClick = { later?.let(onMove) }, enabled = later != null) { Icon(Icons.Outlined.ArrowDownward, "Move later") }
                }
                if (canTrash) IconButton(onClick = onTrash) {
                    Icon(if (trashed) Icons.Outlined.RestoreFromTrash else Icons.Outlined.DeleteOutline,
                        if (trashed) "Restore selected notes" else "Move selected notes to Trash")
                }
            }
        }
        if (!canTrash) Text("Only notes you own can be moved to Trash.", Modifier.padding(horizontal = Spacing.lg),
            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * Sync problems that need the user, and nothing else: a healthy "Synced" or "Saved on device" stays silent, since notes are
 * always saved on the device first.
 */
@Composable
private fun SyncStatus(state: ConnectionState, conflicts: Int, onReauthenticate: () -> Unit, onRetry: () -> Unit, onReview: () -> Unit) {
    val problem: (@Composable () -> Unit)? = when {
        state is ConnectionState.SessionExpired -> { {
            StatusBanner(state.message, tone = BannerTone.Error, title = "Signed out", icon = Icons.Outlined.LockClock,
                actionLabel = "Sign in", onAction = onReauthenticate)
        } }
        conflicts > 0 -> { {
            StatusBanner(if (conflicts == 1) "One edit conflicts with a newer version." else "$conflicts edits conflict with newer versions.",
                tone = BannerTone.Warning, title = "Needs your attention", icon = Icons.Outlined.SyncProblem, actionLabel = "Review", onAction = onReview)
        } }
        state is ConnectionState.Offline -> { {
            StatusBanner(state.message, tone = BannerTone.Warning, title = "Can't reach the server", icon = Icons.Outlined.CloudOff,
                actionLabel = "Retry", onAction = onRetry)
        } }
        state is ConnectionState.GatewayDenied -> { {
            StatusBanner(state.message, tone = BannerTone.Warning, title = "The gateway refused the connection", actionLabel = "Retry", onAction = onRetry)
        } }
        state is ConnectionState.CertificateAttention -> { {
            StatusBanner(state.message, tone = BannerTone.Warning, title = "Certificate needs attention", icon = Icons.Outlined.GppMaybe,
                actionLabel = "Retry", onAction = onRetry)
        } }
        state is ConnectionState.Incompatible -> { {
            StatusBanner(state.message, tone = BannerTone.Warning, title = "Server not supported", actionLabel = "Retry", onAction = onRetry)
        } }
        else -> null
    }
    AnimatedVisibility(problem != null, enter = fadeIn(tween(Motion.ENTER)) + expandVertically(tween(Motion.ENTER)),
        exit = fadeOut(tween(Motion.EXIT)) + shrinkVertically(tween(Motion.EXIT))) {
        // Keeps the last banner on screen while it animates out.
        val shown = remember { arrayOfNulls<@Composable () -> Unit>(1) }.also { if (problem != null) it[0] = problem }[0]
        shown?.invoke()
    }
}

/**
 * The drawer of views: who and where you are, the fixed views, then labels and binders under their own headings, then
 * Settings. Each note view shows how many notes it holds.
 */
@Composable
private fun HomeDrawer(state: DrawerState, choices: List<Pair<String, String>>, counts: Map<String, Int>, server: String, selected: String,
    onSelect: (String) -> Unit, onSettings: () -> Unit) {
    ModalDrawerSheet(drawerState = state) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = Spacing.md)) {
            Row(Modifier.padding(start = Spacing.lg, end = Spacing.lg, top = Spacing.xl, bottom = Spacing.lg),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
                BrandMark(40.dp)
                Column(Modifier.weight(1f)) {
                    Text("Keeparr", style = MaterialTheme.typography.titleLarge)
                    if (server.isNotBlank()) Text(server, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            val labels = choices.filter { it.first.startsWith("label:") }
            val binders = choices.filter { it.first.startsWith("binder:") }
            val views = choices - labels.toSet() - binders.toSet()
            @Composable fun Item(choice: Pair<String, String>) = NavigationDrawerItem(
                label = { Text(choice.second, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                icon = { Icon(filterIcon(choice.first), null) }, selected = selected == choice.first, onClick = { onSelect(choice.first) },
                badge = counts[choice.first]?.takeIf { it > 0 }?.let { count -> { Text(count.toString(), style = MaterialTheme.typography.labelLarge) } },
                colors = NavigationDrawerItemDefaults.colors(unselectedTextColor = MaterialTheme.colorScheme.onSurface,
                    unselectedBadgeColor = MaterialTheme.colorScheme.onSurfaceVariant))
            views.forEach { Item(it) }
            if (labels.isNotEmpty()) {
                DrawerHeading("Labels")
                labels.forEach { Item(it) }
            }
            if (binders.isNotEmpty()) {
                DrawerHeading("Binders")
                binders.forEach { Item(it) }
            }
            HorizontalDivider(Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.sm), color = MaterialTheme.colorScheme.outlineVariant)
            NavigationDrawerItem(label = { Text("Settings") }, icon = { Icon(Icons.Outlined.Settings, null) }, selected = false, onClick = onSettings,
                colors = NavigationDrawerItemDefaults.colors(unselectedTextColor = MaterialTheme.colorScheme.onSurface))
            Spacer(Modifier.height(Spacing.xl))
        }
    }
}

@Composable
private fun DrawerHeading(text: String) {
    SectionHeader(text, Modifier.padding(start = Spacing.lg, top = Spacing.lg, bottom = Spacing.sm).semantics { heading() })
}

private fun filterIcon(key: String): ImageVector = when {
    key == "reminders" -> Icons.Outlined.Notifications
    key == "shared" -> Icons.Outlined.PeopleOutline
    key == "archive" -> Icons.Outlined.Archive
    key == "trash" -> Icons.Outlined.DeleteOutline
    key.startsWith("label:") -> Icons.AutoMirrored.Outlined.Label
    key.startsWith("binder:") -> Icons.Outlined.Folder
    else -> Icons.Outlined.Lightbulb
}

/** The title shown above the content of every view but the main one, so it is always clear where you are. */
private fun viewTitle(filter: String, choices: List<Pair<String, String>>): Pair<String, String?>? = when {
    filter == "home" -> null
    filter == "trash" -> "Trash" to "Notes here are deleted permanently after the server's retention period."
    else -> (choices.firstOrNull { it.first == filter }?.second ?: filter.substringAfter(':')) to null
}

@Composable
private fun ViewHeader(title: String, hint: String?) {
    Column(Modifier.fillMaxWidth().padding(horizontal = Spacing.xs, vertical = Spacing.sm), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        Text(title, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
        hint?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun GridSectionHeader(text: String) {
    SectionHeader(text, Modifier.padding(start = Spacing.xs, top = Spacing.sm, bottom = Spacing.xxs).semantics { heading() })
}

private class EmptyView(val icon: ImageVector, val title: String, val hint: String)

private fun emptyView(filter: String, search: String) = when {
    search.isNotBlank() -> EmptyView(Icons.Outlined.SearchOff, "No matching notes", "Try different words or check the spelling.")
    filter == "reminders" -> EmptyView(Icons.Outlined.Notifications, "No upcoming reminders", "Notes with a reminder appear here.")
    filter == "shared" -> EmptyView(Icons.Outlined.PeopleOutline, "No shared notes", "Notes you share, or that are shared with you, appear here.")
    filter == "archive" -> EmptyView(Icons.Outlined.Archive, "Your archive is empty", "Archive a note to tuck it away without deleting it.")
    filter == "trash" -> EmptyView(Icons.Outlined.DeleteOutline, "Trash is empty", "Notes you delete appear here, so you can still restore them.")
    filter.startsWith("label:") -> EmptyView(Icons.AutoMirrored.Outlined.Label, "No notes with this label", "Add the label to a note and it appears here.")
    filter.startsWith("binder:") -> EmptyView(Icons.Outlined.Folder, "This binder is empty", "Notes you file in this binder appear here.")
    else -> EmptyView(Icons.Outlined.Lightbulb, "Your notes appear here", "Tap + to write your first note.")
}

internal fun canReorderNotes(filter: String, search: String) = search.isBlank() && filter in setOf("home", "pinned")

internal fun searchVisibleNotes(notes: List<Note>, filter: String, search: String): List<Note> {
    val visible = NoteOrder.visible(notes, filter)
    if (search.isBlank()) return visible
    return visible.filter { note ->
        !note.locked && (NoteHtml.titleText(note.title) + " " + NoteHtml.plainText(note.body) + " " + note.items.joinToString { NoteHtml.plainText(it.text("data")) })
            .contains(search, true)
    }
}

/** Whether the note at [index] can swap one place toward [delta] (-1 earlier, +1 later) without leaving its pinned group. */
internal fun canMoveNoteBy(visible: List<Note>, index: Int, delta: Int): Boolean {
    val to = index + delta
    return (delta == -1 || delta == 1) && index in visible.indices && to in visible.indices && visible[index].pinned == visible[to].pinned
}

/** The stored order after moving the note at [index] one place by [delta], or null where that is not allowed. */
internal fun moveNoteBy(visible: List<Note>, index: Int, delta: Int): List<String>? {
    if (!canMoveNoteBy(visible, index, delta)) return null
    return visible.map { it.syncId }.toMutableList().also { java.util.Collections.swap(it, index, index + delta) }
}

internal fun moveDraggedNote(visible: List<Note>, source: Note, targetId: String): List<String>? {
    val from = visible.indexOfFirst { it.syncId == source.syncId }
    val to = visible.indexOfFirst { it.syncId == targetId }
    if (from < 0 || to < 0 || from == to || visible[from].pinned != visible[to].pinned) return null
    val ids = visible.map { it.syncId }.toMutableList()
    ids.add(to, ids.removeAt(from))
    return ids
}
