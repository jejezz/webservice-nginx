module.exports = {
  apps : [{
    name: 'webrtc-singal-server',
    script: './dist/index.js',
    watch: true
  }],

  deploy : {
    production : {
      user : 'jejezz',
      host : 'callfusion.ptype.co.kr',
      ref  : 'origin/master',
      repo : 'GIT_REPOSITORY',
      path : 'DESTINATION_PATH',
      'pre-deploy-local': '',
      'post-deploy' : 'npm install && pm2 reload rtc-signal-server.config.js --env production',
      'pre-setup': ''
    }
  }
};
