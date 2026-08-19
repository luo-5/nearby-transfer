package io.github.nearbytransfer.android.core.data

/** Durable state of one file in a publication journal. */
enum class PublicationFileState {
    PLANNED,
    ALLOCATING,
    ALLOCATED,
    WRITING,
    WRITTEN,
    VERIFIED,
    PUBLISHING,
    PUBLISHED,
    AMBIGUOUS,
    ABORTING,
    ABORT_PENDING,
    ABORTED,
}
