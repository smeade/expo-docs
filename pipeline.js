import spawnAsync from '@exponent/spawn-async';
import git from 'git-promise';
import rimraf from 'rimraf';

import CI, { Rocker, Kubernetes as K8S, Log, Github } from 'ci';

export default {
  config: {
    name: '📚 Docs',
    shortname: 'docs',
    description: 'Docs Build/Deploy',
    branches: 'master',
    allowPRs: true,
  },
  steps: (branch, tag, pr) => {
    if (tag) {
      // all we need to do when there's a tag is deploy
      return [
        deploy(branch, tag, pr),
        CI.waitStep(),
        updateSearchIndex(branch, tag, pr),
      ];
    }
    const steps = [
      build(branch, tag, pr),
      CI.waitStep(),
      deploy(branch, tag, pr),
    ];
    if (!pr) {
      steps.push(CI.blockStep(':shipit: Deploy to Production?'), tagRelease);
    }
    return steps;
  },
};

const build = (branch, tag, pr) => ({
  name: `:hammer: Build`,
  agents: {
    queue: 'builder',
  },
  async command() {
    const imageName = `gcr.io/exponentjs/exponent-docs-v2`;
    const imageTag = `${process.env.BUILDKITE_COMMIT}`;

    Log.collapsed(':hammer: Building Docs...');

    // Added until caching issues between builds have been resolved in Gatsby.
    // Without it, sometimes docs don't update as expected, eg: a section
    // that appears locally won't exist on staging/production
    rimraf.sync('./gatsby/.intermediate-representation');
    rimraf.sync('./gatsby/public');

    await Rocker.build({
      rockerfile: './deploy/docker/deploy.Rockerfile',
      context: '.',
      vars: {
        ImageName: imageName,
        ImageTag: imageTag,
        DocsVersion: `v${require('./package.json').version}`,
      },
      options: {
        pull: true,
        push: true,
      },
    });
  },
});

const deploy = (branch, tag, pr) => ({
  name: `:rocket: Deploy to ${tag && !pr ? 'Production' : pr ? 'Dev' : 'Staging'}`,
  concurrency: 1,
  concurrency_group: `docs/${tag && !pr ? 'prod' : pr ? `pr-${pr}` : 'staging'}/deploy`,
  async command() {
    if (!pr && branch !== 'master' && !tag) {
      return;
    }

    const isProduction = tag && !pr;

    let environment, ingressHostname;
    if (isProduction) {
      environment = 'production';
      ingressHostname = 'docs.expo.io';
    } else if (pr) {
      environment = `docs-pr-${pr}`;
      ingressHostname = `${environment}.pr.exp.host`;
    } else {
      environment = 'staging';
      ingressHostname = 'staging.docs.expo.io';
    }

    const imageName = `gcr.io/exponentjs/exponent-docs-v2`;
    const imageTag = `${process.env.BUILDKITE_COMMIT}`;

    Log.collapsed(':gcloud: Deploy to K8s...');

    await Github.performDeployment(
      {
        projectName: 'docs',
        environment,
        deploymentUrl: `https://${ingressHostname}`,
        deploymentType: 'k8s',
        prNumber: pr,
      },
      // deployment function
      async () => {
        await K8S.deployHelmChart({
          clusterName: 'exp-central',
          chartPath: './deploy/charts/docs',
          namespace: environment,
          releaseName: `docs-${environment}`,
          values: {
            image: {
              repository: imageName,
              tag: imageTag,
            },
            replicaCount: environment === 'production' ? 2 : 1, // PRS // Staging
            ingress: [
              {
                host: ingressHostname,
              },
            ],
          },
        });
      }
    );
  },
});

const updateSearchIndex = (branch, tag, pr) => ({
  name: `:feelsgood: Update Search Index`,
  async command() {
    if (branch !== 'master' && !tag) {
      return;
    }

    Log.collapsed(':open_mouth: Updating search index...');

    await spawnAsync(
      'yarn',
      ['run', 'update-search-index', '--', 'docs.expo.io'],
      {
        stdio: 'inherit',
      }
    );
  },
});

const tagRelease = {
  name: ':git: Tag Release',
  async command() {
    Log.collapsed(':git: Tagging Release...'); // Build tag name
    const tag = `docs/release-${await makeVersionName()}`;
    await git(`tag ${tag}`);
    Log.collapsed(':github: Pushing Release...');
    await git(`push origin ${tag}`); // upload more steps
    global.currentPipeline.upload(global.currentPipeline.steps(tag, tag, null));
  },
};

function pad(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

async function makeVersionName() {
  const hash = (await git(
    `rev-parse --short=12 ${process.env.BUILDKITE_COMMIT}`
  )).trim();
  const today = new Date();
  return `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}-${hash}`;
}
