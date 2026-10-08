package dev.keeparr.android.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner

/**
 * One [ViewModelStore] per open editor session, held by a ViewModel of the activity so a session survives
 * configuration changes but can be released individually. Keying editors inside the activity's own store kept every
 * opened note's ViewModel (and its snapshot collectors and draft copy) alive until the activity was destroyed.
 */
internal class EditorSessionStores : ViewModel() {
    private val stores = HashMap<String, ViewModelStore>()

    val openSessions: Int @Synchronized get() = stores.size

    @Synchronized fun ownerFor(key: String): ViewModelStoreOwner {
        val store = stores.getOrPut(key) { ViewModelStore() }
        return object : ViewModelStoreOwner { override val viewModelStore = store }
    }

    /** Clears the session's ViewModels (cancelling their coroutines); a later open starts fresh. */
    @Synchronized fun release(key: String) {
        stores.remove(key)?.clear()
    }

    public override fun onCleared() {
        synchronized(this) {
            stores.values.forEach { it.clear() }
            stores.clear()
        }
    }
}
