plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.devtools.ksp")
}
android {
    namespace = "dev.kept.android"
    compileSdk = 35
    defaultConfig {
        applicationId = "dev.kept.android"
        minSdk = 34
        targetSdk = 35
        versionCode = 2
        versionName = "2.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    // Production signing comes from the environment (or -P properties) and never from the repository. Without it the
    // release build is signed with the debug key so it stays installable locally and for benchmarks; such an APK must
    // not be distributed. Shrinking is opt-in (-Pkept.minify=true) until it has been exercised on a device.
    val releaseKeystore = (findProperty("kept.release.keystore") as String?) ?: System.getenv("KEPT_RELEASE_KEYSTORE")
    if (releaseKeystore != null) {
        signingConfigs.create("production") {
            storeFile = file(releaseKeystore)
            storePassword = (findProperty("kept.release.storePassword") as String?) ?: System.getenv("KEPT_RELEASE_STORE_PASSWORD")
            keyAlias = (findProperty("kept.release.keyAlias") as String?) ?: System.getenv("KEPT_RELEASE_KEY_ALIAS")
            keyPassword = (findProperty("kept.release.keyPassword") as String?) ?: System.getenv("KEPT_RELEASE_KEY_PASSWORD")
        }
    }
    buildTypes {
        release {
            signingConfig = signingConfigs.getByName(if (releaseKeystore != null) "production" else "debug")
            val shrink = findProperty("kept.minify") == "true"
            isMinifyEnabled = shrink
            isShrinkResources = shrink
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    testOptions { unitTests.isIncludeAndroidResources = true }
}
tasks.withType<org.gradle.api.tasks.testing.Test>().configureEach {
    systemProperty("kept.native.fixture", rootProject.projectDir.parentFile.resolve("test-fixtures/native-contract.json").absolutePath)
}
ksp { arg("room.schemaLocation", "$projectDir/schemas") }
dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.compose.ui:ui:1.7.6")
    implementation("androidx.compose.foundation:foundation:1.7.6")
    implementation("androidx.compose.material3:material3:1.3.1")
    implementation("androidx.compose.material:material-icons-extended:1.7.6")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.datastore:datastore-preferences:1.1.1")
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.caverock:androidsvg-aar:1.4")
    implementation("org.jsoup:jsoup:1.18.3")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("androidx.sqlite:sqlite-framework:2.4.0")
}
