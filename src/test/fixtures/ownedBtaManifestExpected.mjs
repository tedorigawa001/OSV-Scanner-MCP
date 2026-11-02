export const btaManifestCases=Object.freeze({
 'completed':null,'unchanged':null,
 'snapshot-modified':'snapshot_stale','snapshot-swapped':'snapshot_stale','snapshot-old-bytes':'snapshot_stale','snapshot-storage':'snapshot_storage_mismatch',
 'generation-exchanged':'generation_binding_mismatch','library-modified':'library_stale','library-order':'cohort_binding_mismatch','library-duplicate-dropped':'cohort_binding_mismatch',
 'default-configuration':'configuration_unregistered','foreign-configuration':'configuration_binding_mismatch','foreign-parameter':'parameter_binding_mismatch','parameter-snapshot-order':'parameter_binding_mismatch',
 'foreign-project':'context_binding_mismatch','source-modified':'source_stale','arguments-exchanged':'context_binding_mismatch',
 'snapshot-after-call':'snapshot_stale','snapshot-before-capture':'snapshot_stale'
});
export const runtimeRefusals=Object.freeze({'runtime-order':'runtime_binding_mismatch','runtime-duplicate-dropped':'runtime_binding_mismatch','runtime-modified':'runtime_stale','driver-modified':'driver_stale'});
export const bridgeSources=['src/test/fixtures/OwnedBtaManifestDriver.java','src/test/fixtures/ownedBtaManifestProducer.mjs','src/test/fixtures/ownedBtaManifestContract.mjs','src/test/fixtures/ownedBtaManifestExpected.mjs','src/test/fixtures/ownedManifestContract.mjs','src/test/fixtures/ownedJavacContract.mjs','src/test/fixtures/ownedJavacExpected.mjs','src/test/fixtures/gradleSnapshotOwnerExpected.mjs','src/test/fixtures/gradleBtaDriverRuntime.mjs','src/test/fixtures/gradle-owned-bta-manifest.gradle'];
export const bridgeVerificationSources=['src/test/gradle/btaManifest.integration.test.ts','src/test/gradle/btaManifest.test.ts','src/test/manual/gradleOwnedBtaManifestResults.mjs','src/test/fixtures/ownedBtaManifestContract.d.mts','src/test/fixtures/ownedBtaManifestExpected.d.mts'];

export const consumerBytes='package consumer\nfun value() = dep.Library().value()\n';
export const libraryBytes=['package dep\nclass Library { fun value(): String = \"old\" }\n','package dep\nclass Library { fun value(): String = \"current\"; fun extra(): Int = 7 }\n'];
