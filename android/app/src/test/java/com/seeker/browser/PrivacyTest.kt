package com.seeker.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PrivacyTest {
    @Test fun registrableDomains() {
        assertEquals("example.com", Privacy.siteOf("a.b.example.com"))
        assertEquals("bbc.co.uk", Privacy.siteOf("www.bbc.co.uk"))
        assertEquals("flipkart.co.in", Privacy.siteOf("m.flipkart.co.in"))
        assertEquals("user.github.io", Privacy.siteOf("user.github.io"))
        assertEquals("127.0.0.1", Privacy.siteOf("127.0.0.1"))
    }

    @Test fun partyGroupsAndExceptions() {
        assertTrue(Privacy.sameParty("www.youtube.com", "i.ytimg.com"))
        assertFalse(Privacy.sameParty("example.com", "google.com"))
        assertTrue(Privacy.isException("accounts.google.com", Prefs.DEFAULT_EXCEPTIONS))
        assertFalse(Privacy.isException("example.org", Prefs.DEFAULT_EXCEPTIONS))
    }

    @Test fun stripsTrackingParameters() {
        assertEquals("https://shop.com/p?id=7", Privacy.cleanUrl("https://shop.com/p?id=7&utm_source=x&fbclid=abc"))
        assertEquals("https://shop.com/p", Privacy.cleanUrl("https://shop.com/p?gclid=1#utm_medium=e"))
        assertEquals("https://shop.com/p?id=1#top", Privacy.cleanUrl("https://shop.com/p?id=1#top"))
        // generic names are only stripped on sites known to use them for tracking
        assertEquals("https://blog.com/?si=3", Privacy.cleanUrl("https://blog.com/?si=3"))
        assertEquals("https://www.youtube.com/watch?v=abc", Privacy.cleanUrl("https://www.youtube.com/watch?v=abc&si=xyz&pp=1"))
    }

    @Test fun unwrapsRedirectTrackers() {
        assertEquals("https://example.com/a", Privacy.unwrapRedirect("https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fa%3Futm_source%3Dg&sa=D"))
        assertEquals("https://news.site/x", Privacy.unwrapRedirect("https://l.facebook.com/l.php?u=https%3A%2F%2Fnews.site%2Fx%3Ffbclid%3D1&h=AT"))
        assertNull(Privacy.unwrapRedirect("https://example.com/url?q=https://evil"))
        assertNull(Privacy.unwrapRedirect("https://www.google.com/url?q=javascript:alert(1)"))
    }

    @Test fun blocksAdHostsAndSubdomains() {
        assertTrue(Privacy.isBlocked("https://securepubads.g.doubleclick.net/tag/js/gpt.js"))
        assertTrue(Privacy.isBlocked("https://www.googletagmanager.com/gtm.js?id=1"))
        assertFalse(Privacy.isBlocked("https://www.google.com/search?q=x"))
        assertFalse(Privacy.isBlocked("not a url"))
    }

    @Test fun sensitivePagesAreNotRemembered() {
        assertTrue(Privacy.isSensitive("https://netbanking.hdfc.com/"))
        assertTrue(Privacy.isSensitive("https://site.com/login?next=/"))
        assertFalse(Privacy.isSensitive("https://en.wikipedia.org/wiki/Tor"))
    }
}
