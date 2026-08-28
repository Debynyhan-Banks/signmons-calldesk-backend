import { Inject, Injectable } from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import {
  applicationDefault,
  getApps,
  initializeApp,
  type App,
  type AppOptions,
} from "firebase-admin/app";
import { getAuth as getFirebaseAuth, type Auth } from "firebase-admin/auth";
import appConfig from "../config/app.config";

@Injectable()
export class FirebaseAdminService {
  private readonly app: App;

  constructor(
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {
    const apps = getApps();
    if (apps.length > 0 && apps[0]) {
      this.app = apps[0];
      return;
    }

    const options: AppOptions = {};
    const projectId =
      this.config.firebaseProjectId ??
      process.env.GOOGLE_CLOUD_PROJECT ??
      undefined;
    if (projectId) {
      options.projectId = projectId;
    }

    options.credential = applicationDefault();
    this.app = initializeApp(options);
  }

  getAuth(): Auth {
    return getFirebaseAuth(this.app);
  }
}
