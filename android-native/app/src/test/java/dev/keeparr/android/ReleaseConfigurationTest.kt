package dev.keeparr.android

import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ComponentInfo
import org.robolectric.RuntimeEnvironment
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Merged-manifest contract for the installed app: version, entry points, share targets and what is exported. */
@RunWith(RobolectricTestRunner::class)
class ReleaseConfigurationTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private val packages get() = context.packageManager

    private fun resolvesToMain(intent: Intent) =
        packages.queryIntentActivities(intent.setPackage(context.packageName), 0).any { it.activityInfo.name == MainActivity::class.java.name }

    @Test fun versionMatchesTheV2Release() {
        val info = packages.getPackageInfo(context.packageName, 0)
        assertEquals("2.0.2", info.versionName)
        assertEquals(4L, info.longVersionCode)
    }

    @Test fun launcherAndShareIntentsReachTheMainActivity() {
        assertTrue(resolvesToMain(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)))
        assertTrue(resolvesToMain(Intent(Intent.ACTION_SEND).addCategory(Intent.CATEGORY_DEFAULT).setType("text/plain")))
        assertTrue(resolvesToMain(Intent(Intent.ACTION_SEND).addCategory(Intent.CATEGORY_DEFAULT).setType("image/png")))
        assertTrue(resolvesToMain(Intent(Intent.ACTION_SEND_MULTIPLE).addCategory(Intent.CATEGORY_DEFAULT).setType("image/png")))
        assertFalse("unrelated MIME types are not accepted as shares",
            resolvesToMain(Intent(Intent.ACTION_SEND).addCategory(Intent.CATEGORY_DEFAULT).setType("video/mp4")))
    }

    @Test fun onlyTheEntryPointsAreExported() {
        val info = packages.getPackageInfo(context.packageName, PackageManager.GET_ACTIVITIES or PackageManager.GET_RECEIVERS or
            PackageManager.GET_SERVICES or PackageManager.GET_PROVIDERS)
        val components: List<ComponentInfo> = info.activities.orEmpty().toList() + info.receivers.orEmpty().toList() + info.services.orEmpty().toList()
        val (own, library) = components.filter { it.exported }.partition { it.name.startsWith("dev.keeparr.android.") }
        assertEquals(setOf("MainActivity", "WidgetConfigActivity", "ReminderLifecycleReceiver"), own.map { it.name.substringAfterLast('.') }.toSet())
        // WorkManager and profile-installer components are exported for the system; each must demand a system-only permission.
        for (component in library) {
            val permission = when (component) {
                is android.content.pm.ServiceInfo -> component.permission
                is android.content.pm.ActivityInfo -> component.permission
                else -> null
            } ?: packages.getReceiverInfo(ComponentName(component.packageName, component.name), 0).permission
            assertNotNull("${component.name} is exported without a permission", permission)
        }
        assertTrue("provider must not be exported", info.providers.orEmpty().none { it.exported })
    }

    @Test fun widgetProvidersAndTheirConfigurationAreRegistered() {
        for (name in listOf("dev.keeparr.android.widgets.NotesWidget", "dev.keeparr.android.widgets.QuickCreateWidget")) {
            val receiver = packages.getReceiverInfo(ComponentName(context.packageName, name), PackageManager.GET_META_DATA)
            assertFalse("$name must not be exported", receiver.exported)
            assertNotNull("$name declares an appwidget provider", receiver.metaData?.getInt("android.appwidget.provider"))
        }
        val remoteViews = packages.getServiceInfo(ComponentName(context.packageName, "dev.keeparr.android.widgets.NotesWidgetService"), 0)
        assertEquals("android.permission.BIND_REMOTEVIEWS", remoteViews.permission)
    }

    @Test fun reminderLifecycleReceiverListensForTheSystemEventsThatInvalidateAlarms() {
        val actions = listOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED, Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED)
        for (action in actions) {
            val receivers = packages.queryBroadcastReceivers(Intent(action).setPackage(context.packageName), 0)
            assertTrue("$action must reach the lifecycle receiver", receivers.any { it.activityInfo.name.endsWith("ReminderLifecycleReceiver") })
        }
    }
}
