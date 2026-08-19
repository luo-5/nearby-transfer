package io.github.nearbytransfer.android.core.data

/** Durable publication lifecycle, independent from the transfer transport state. */
enum class PublicationState {
    NONE,
    PREPARED,
    PUBLISHING,
    RECONCILE_REQUIRED,
    PARTIAL,
    PUBLISHED,
    CANCEL_PENDING,
    CANCELLED,
    LEGACY_UNVERIFIED,
}
