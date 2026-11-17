plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Seeker search runs from the same JS/CSS as the desktop app: copy src/pages/seeker at build time.
val seekerAssets = layout.buildDirectory.dir("generated/seekerAssets")
val copySeekerAssets by tasks.registering(Copy::class) {
    from(rootProject.file("../src/pages/seeker")) {
        include("*.js", "*.css")
    }
    into(seekerAssets.map { it.dir("seeker") })
}

android {
    namespace = "com.seeker.browser"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.seeker.browser"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.1.0-android"
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Self-signed with the debug key so CI can produce an installable release APK too.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    sourceSets["main"].assets.srcDir(seekerAssets)
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
}

tasks.named("preBuild") { dependsOn(copySeekerAssets) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    testImplementation("junit:junit:4.13.2")
}
