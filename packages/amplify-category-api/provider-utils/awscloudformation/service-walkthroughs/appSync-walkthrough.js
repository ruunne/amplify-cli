const inquirer = require('inquirer');
const fs = require('fs-extra');
const path = require('path');
const openInEditor = require('open-in-editor');

const category = 'api';
const serviceName = 'AppSync';
const parametersFileName = 'parameters.json';
const schemaFileName = 'schema.graphql';


async function serviceWalkthrough(context, defaultValuesFilename, serviceMetadata) {
  const resourceName = resourceAlreadyExists(context);

  if (resourceName) {
    context.print.warning('You already have an appsync API in your project. Please use "amplify update api" command to update your existing AppSync API');
    process.exit(0);
  }


  const { amplify } = context;
  const { inputs } = serviceMetadata;
  const defaultValuesSrc = `${__dirname}/../default-values/${defaultValuesFilename}`;
  const { getAllDefaults } = require(defaultValuesSrc);
  const allDefaultValues = getAllDefaults(amplify.getProjectDetails());

  const resourceQuestions = [
    {
      type: inputs[1].type,
      name: inputs[1].key,
      message: inputs[1].question,
      validate: amplify.inputValidation(inputs[1]),
      default: answers => answers.resourceName,
    },
  ];

  // API name question

  const resourceAnswers = await inquirer.prompt(resourceQuestions);
  resourceAnswers[inputs[0].key] = resourceAnswers[inputs[1].key];

  const parameters = {
    AppSyncApiName: resourceAnswers[inputs[1].key],
  };

  // Ask auth/security question

  const authType = await askSecurityQuestions(context, parameters);

  // Ask schema file question

  const schemaFileQuestion = {
    type: inputs[2].type,
    name: inputs[2].key,
    message: inputs[2].question,
    validate: amplify.inputValidation(inputs[2]),
    default: () => {
      const defaultValue = allDefaultValues[inputs[2].key];
      return defaultValue;
    },
  };

  const schemaFileAnswer = await inquirer.prompt(schemaFileQuestion);


  const backendDir = amplify.pathManager.getBackendDirPath();

  const resourceDir = `${backendDir}/${category}/${resourceAnswers[inputs[0].key]}`;


  if (schemaFileAnswer[inputs[2].key]) {
    // User has an annotated schema file

    const filePathQuestion = {
      type: inputs[3].type,
      name: inputs[3].key,
      message: inputs[3].question,
      validate: amplify.inputValidation(inputs[3]),
    };
    const { schemaFilePath } = await inquirer.prompt(filePathQuestion);

    fs.ensureDirSync(resourceDir);
    fs.copyFileSync(schemaFilePath, `${resourceDir}/${schemaFileName}`);

    await context.amplify.executeProviderUtils(context, 'awscloudformation', 'compileSchema', { resourceDir, parameters });

    return { answers: resourceAnswers, output: { securityType: authType }, noCfnFile: true };
  }

  // The user doesn't have an annotated schema file

  if (!await context.prompt.confirm('Do you want a guided schema creation?')) {
    // Copy the most basic schema onto the users resource dir and transform that
    const schemaFilePath = `${__dirname}/../appsync-schemas/basic-schema.graphql`;
    const targetSchemaFilePath = `${resourceDir}/${schemaFileName}`;

    context.print.info('Creating a base schema for you...');

    fs.ensureDirSync(resourceDir);
    fs.copyFileSync(schemaFilePath, targetSchemaFilePath);

    await context.amplify.executeProviderUtils(context, 'awscloudformation', 'compileSchema', { resourceDir, parameters, noConfig: true });

    return { answers: resourceAnswers, output: { securityType: authType }, noCfnFile: true };
  }
  // Guided creation of the transform schema

  const templateQuestions = [
    {
      type: inputs[4].type,
      name: inputs[4].key,
      message: inputs[4].question,
      choices: inputs[4].options,
      validate: amplify.inputValidation(inputs[4]),
    },
    {
      type: inputs[5].type,
      name: inputs[5].key,
      message: inputs[5].question,
      validate: amplify.inputValidation(inputs[5]),
      default: () => {
        const defaultValue = allDefaultValues[inputs[5].key];
        return defaultValue;
      },
    },
  ];

  const { templateSelection, editSchemaChoice } = await inquirer.prompt(templateQuestions);
  const schemaFilePath = `${__dirname}/../appsync-schemas/${templateSelection}`;
  const targetSchemaFilePath = `${resourceDir}/${schemaFileName}`;

  fs.ensureDirSync(resourceDir);
  fs.copyFileSync(schemaFilePath, targetSchemaFilePath);

  if (editSchemaChoice) {
    const editorQuestion = {
      type: inputs[6].type,
      name: inputs[6].key,
      message: inputs[6].question,
      choices: inputs[6].options,
      validate: amplify.inputValidation(inputs[6]),
    };

    const { editorSelection } = await inquirer.prompt(editorQuestion);
    let editorOption = {};
    if (editorSelection !== 'none') {
      editorOption = {
        editor: editorSelection,
      };
    }
    const editor = openInEditor.configure(editorOption, (err) => {
      console.error(`Editor not found in your machine. Please open your favorite editor and modify the file if needed: ${err}`);
    });

    return editor.open(targetSchemaFilePath)
      .then(async () => {
        const continueQuestion = {
          type: 'input',
          name: 'pressKey',
          message: 'Press any key to continue',
        };

        await inquirer.prompt(continueQuestion);
      }, (err) => {
        context.print.error(`Something went wrong: ${err}. Please manually edit the graphql schema`);
      })
      .then(async () => {
        await context.amplify.executeProviderUtils(context, 'awscloudformation', 'compileSchema', { resourceDir, parameters });
        return { answers: resourceAnswers, output: { securityType: authType }, noCfnFile: true };
      });
  }
  await context.amplify.executeProviderUtils(context, 'awscloudformation', 'compileSchema', { resourceDir, parameters });
  return { answers: resourceAnswers, output: { securityType: authType }, noCfnFile: true };
}

async function updateWalkthrough(context) {
  const { allResources } = await context.amplify.getResourceStatus();
  let resourceDir;
  let resourceName;
  const resources = allResources.filter(resource => resource.service === 'AppSync');
  // There can only be one appsync resource
  if (resources.length > 0) {
    const resource = resources[0];
    ({ resourceName } = resource);
    const backEndDir = context.amplify.pathManager.getBackendDirPath();
    resourceDir = path.normalize(path.join(backEndDir, category, resourceName));
  } else {
    context.print.error('No appsync resource to update. Please use "amplify add api" command to update your existing AppSync API');
    process.exit(0);
    return;
  }

  const parametersFilePath = path.join(resourceDir, parametersFileName);
  let parameters = {};

  try {
    parameters = JSON.parse(fs.readFileSync(parametersFilePath));
  } catch (e) {
    context.print.error('Paramters file not found');
    context.print.info(e.stack);
  }

  const authType = await askSecurityQuestions(context, parameters);

  const amplifyMetaFilePath = context.amplify.pathManager.getAmplifyMetaFilePath();
  const amplifyMeta = JSON.parse(fs.readFileSync(amplifyMetaFilePath));

  amplifyMeta[category][resourceName].output.securityType = authType;
  const jsonString = JSON.stringify(amplifyMeta, null, '\t');
  fs.writeFileSync(amplifyMetaFilePath, jsonString, 'utf8');

  await context.amplify.executeProviderUtils(context, 'awscloudformation', 'compileSchema', { resourceDir, parameters });
}

async function askSecurityQuestions(context, parameters) {
  const securityTypeQuestion = {
    type: 'list',
    name: 'authType',
    message: 'Choose an authorization type for the API',
    choices: [
      {
        name: 'API key',
        value: 'API_KEY',
      },
      {
        name: 'Amazon Cognito User Pool',
        value: 'AMAZON_COGNITO_USER_POOLS',
      },
    ],
  };

  const { authType } = await inquirer.prompt([securityTypeQuestion]);

  if (authType === 'AMAZON_COGNITO_USER_POOLS') {
    let authResourceName = checkIfAuthExists(context);

    if (!authResourceName) {
      try {
        const { add } = require('amplify-category-auth');

        authResourceName = await add(context);
      } catch (e) {
        context.print.error('Auth plugin not installed in the CLI. Please install it to use this feature');
      }
    } else {
      context.print.info('Using cognito user pool configured as a part of this project');
    }

    parameters.AuthCognitoUserPoolId = {
      'Fn::GetAtt': [
        `auth${authResourceName}`,
        'Outputs.UserPoolId',
      ],
    };
  } else if (authType === 'API_KEY') {
    if (parameters.AuthCognitoUserPoolId) {
      delete parameters.AuthCognitoUserPoolId;
    }
  }

  return authType;
}

function resourceAlreadyExists(context) {
  const { amplify } = context;
  const { amplifyMeta } = amplify.getProjectDetails();
  let resourceName;

  if (amplifyMeta[category]) {
    const categoryResources = amplifyMeta[category];
    Object.keys(categoryResources).forEach((resource) => {
      if (categoryResources[resource].service === serviceName) {
        resourceName = resource;
      }
    });
  }

  return resourceName;
}


function checkIfAuthExists(context) {
  const { amplify } = context;
  const { amplifyMeta } = amplify.getProjectDetails();
  let authResourceName;
  const authServiceName = 'Cognito';
  const authCategory = 'auth';

  if (amplifyMeta[authCategory] && Object.keys(amplifyMeta[authCategory]).length > 0) {
    const categoryResources = amplifyMeta[authCategory];
    Object.keys(categoryResources).forEach((resource) => {
      if (categoryResources[resource].service === authServiceName) {
        authResourceName = resource;
      }
    });
  }
  return authResourceName;
}


module.exports = { serviceWalkthrough, updateWalkthrough };