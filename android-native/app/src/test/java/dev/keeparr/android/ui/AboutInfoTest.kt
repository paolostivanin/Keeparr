package dev.keeparr.android.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AboutInfoTest {
    @Test fun aboutKeepsTheUpstreamAttributionAndLicense() {
        assertTrue(AboutInfo.ORIGIN.startsWith("Keeparr is a modified derivative of Kept by ericerkz."))
        assertTrue(AboutInfo.ORIGIN.contains("Paolo Stivanin"))
        assertEquals("https://github.com/ericerkz/kept", AboutInfo.UPSTREAM_URL)
        assertTrue(AboutInfo.LICENSE.contains("AGPL-3.0-only"))
        assertTrue(AboutInfo.SCAFFOLD.contains("google-keep-clone"))
    }
}
