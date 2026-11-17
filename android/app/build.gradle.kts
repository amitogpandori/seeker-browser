plugins {
    id("com.android.application")
}

// Seeker search runs from the same JS/CSS as the desktop app: copy src/pages/seeker at build time.
val seekerAssets = layout.buildDirectory.dir("generated/seekerAssets")
val copySeekerAssets by tasks.registering(Copy::class) {
    from(rootProject.file("../src/pages/seeker")) {
        include("*.js", "*.css")
    }
    into(seekerAssets.map { it.dir("seeker") })
}

// Version: android-vX.Y.Z releases. CI passes the run number as the version code.
val seekerVersion = "1.0.0"
val seekerVersionCode = (System.getenv("SEEKER_VERSION_CODE") ?: "1").toInt()

android {
    namespace = "com.seeker.browser"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.seeker.browser"
        minSdk = 24
        targetSdk = 36
        versionCode = seekerVersionCode
        versionName = seekerVersion
    }

    signingConfigs {
        // Stable release key from CI secrets (never committed). Without it, release falls back to the debug key.
        val ks = System.getenv("SEEKER_KEYSTORE")
        if (ks != null && file(ks).exists()) {
            create("release") {
                storeFile = file(ks)
                storePassword = System.getenv("SEEKER_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("SEEKER_KEY_ALIAS")
                keyPassword = System.getenv("SEEKER_KEY_PASSWORD")
                enableV1Signing = true   // AGP drops v1 automatically for minSdk 24+ (v2/v3 cover Android 7+)
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }
    sourceSets["main"].assets.directories.add(seekerAssets.get().asFile.path)
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { buildConfig = true }
    packaging {
        // no native code ships in the APK; keep it that way (16 KB page-size safe)
        jniLibs { useLegacyPackaging = false }
    }
    lint {
        abortOnError = true
        checkReleaseBuilds = true
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

tasks.named("preBuild") { dependsOn(copySeekerAssets) }

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.appcompat:appcompat:1.8.0")
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("com.google.android.material:material:1.14.0")
    implementation("androidx.recyclerview:recyclerview:1.4.0")
    implementation("androidx.webkit:webkit:1.18.0")
    implementation("androidx.preference:preference-ktx:1.2.1")
    implementation("androidx.browser:browser:1.10.0")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
}
