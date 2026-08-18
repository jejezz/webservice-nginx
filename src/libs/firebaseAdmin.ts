
import firebase from 'firebase-admin';
import { Messaging } from 'firebase-admin/messaging';
import serviceAccount from '../config/firebase-admin.json';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @brief Load Firebase service account configuration with environment variable support
 * @details Uses default import but can be extended to support custom paths via environment variables
 */
let accountParams: any;

// Check if custom Firebase service account path is provided via environment variable
if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH && fs.existsSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH)) {
  try {
    const customServiceAccount = JSON.parse(fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8'));
    accountParams = {               //clone json object into new object to make typescript happy
      type: customServiceAccount.type,
      projectId: customServiceAccount.project_id,
      privateKeyId: customServiceAccount.private_key_id,
      privateKey: customServiceAccount.private_key,
      clientEmail: customServiceAccount.client_email,
      clientId: customServiceAccount.client_id,
      authUri: customServiceAccount.auth_uri,
      tokenUri: customServiceAccount.token_uri,
      authProviderX509CertUrl: customServiceAccount.auth_provider_x509_cert_url,
      clientC509CertUrl: customServiceAccount.client_x509_cert_url
    };
  } catch (error) {
    console.warn('Failed to load custom Firebase service account, using default:', error);
    // Fallback to default configuration
    accountParams = {
      type: serviceAccount.type,
      projectId: serviceAccount.project_id,
      privateKeyId: serviceAccount.private_key_id,
      privateKey: serviceAccount.private_key,
      clientEmail: serviceAccount.client_email,
      clientId: serviceAccount.client_id,
      authUri: serviceAccount.auth_uri,
      tokenUri: serviceAccount.token_uri,
      authProviderX509CertUrl: serviceAccount.auth_provider_x509_cert_url,
      clientC509CertUrl: serviceAccount.client_x509_cert_url
    };
  }
} else {
  // Use default Firebase service account configuration
  accountParams = {               //clone json object into new object to make typescript happy
    type: serviceAccount.type,
    projectId: serviceAccount.project_id,
    privateKeyId: serviceAccount.private_key_id,
    privateKey: serviceAccount.private_key,
    clientEmail: serviceAccount.client_email,
    clientId: serviceAccount.client_id,
    authUri: serviceAccount.auth_uri,
    tokenUri: serviceAccount.token_uri,
    authProviderX509CertUrl: serviceAccount.auth_provider_x509_cert_url,
    clientC509CertUrl: serviceAccount.client_x509_cert_url
  };
}

export class Firebase {
  private static instance: Firebase;
  private app : firebase.app.App;
  private constructor() {
    this.app = firebase.initializeApp({
      credential: firebase.credential.cert(accountParams),
    })
  }

  public getApp() : firebase.app.App {
    return this.app;
  }

  // 3. A static public method to get the instance.
  // This is the sole entry point for accessing the singleton.
  public static getInstance(): Firebase {
    // If the instance doesn't exist, create it.
    if (!Firebase.instance) {
      Firebase.instance = new Firebase();
    }
    // Always return the same instance.
    return Firebase.instance;
  }
  
  public static getMessaging() : Messaging {
    return Firebase.getInstance().getApp().messaging();
  }
}

// let serviceAccount = require('../config/firebase-admin.json');
// firebase.initializeApp({
//   credential: firebase.credential.cert(serviceAccount),
// })

// module.exports = firebase
