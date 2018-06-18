const aws = require('./aws.js');
const S3 = require('./aws-s3');
const fs = require('fs');
const path = require('path');
const _ = require('lodash');
const providerName = require('../../constants').ProviderName;
const columnify = require('columnify');

class CloudFormation {
  constructor(context) {
    return aws.configureWithCreds(context)
      .then((awsItem) => {
        this.cfn = new awsItem.CloudFormation();
        this.context = context;
        this.eventComplete = false;
        return this;
      });
  }

  createResourceStack(cfnParentStackParams) {
    const cfnModel = this.cfn;
    const { context } = this;
    const cfnCompleteStatus = 'stackCreateComplete';
    const cfnStackCheckParams = {
      StackName: cfnParentStackParams.StackName,
    };
    const self = this;
    self.eventStartTime = new Date();

    return new Promise((resolve, reject) => {
      cfnModel.createStack(cfnParentStackParams, (createErr, data) => {
        this.readStackEvents(cfnParentStackParams.StackName);
        if (createErr) {
          context.print.error('Error creating cloudformation stack');
          reject(createErr);
        }
        cfnModel.waitFor(cfnCompleteStatus, cfnStackCheckParams, (completeErr) => {
          self.eventComplete = true;
          if (completeErr) {
            context.print.error('Error creating cloudformation stack');
            reject(completeErr);
          }
          resolve(data);
        });
      });
    });
  }

  readStackEvents(stackName) {
    // Stores all the events displayed to the user (useful to do a diff with new Events)
    let allShownEvents = [];
    const self = this;
    const cfnModel = this.cfn;
    const params = {
      StackName: stackName,
    };
    const pollForEvents = setInterval(() => {
      if (self.eventComplete) {
        clearInterval(pollForEvents);
      }
      cfnModel.describeStackEvents(params, (err, data) => {
        if (err) {
          console.log(err);
          /* Not throwing error out here since this is an asynchornous event
          running in the background */
        } else {
          let stackEvents = data.StackEvents;
          stackEvents = stackEvents.filter(event => self.eventStartTime
            < new Date(event.Timestamp));

          if (allShownEvents.length === 0) { // Showing events for the first time to the user
            if (stackEvents.length > 0) {
              showEvents(stackEvents);
              allShownEvents = stackEvents;
            }
          } else {
            let newEvents = _.differenceBy(stackEvents, allShownEvents, 'EventId');

            if (newEvents.length > 0) {
              // To store all the uniq nestedStacks which are a part of the new found events
              const nestedStacks = [];
              const nestedStackEventPromises = [];

              for (let i = 0; i < newEvents.length; i += 1) {
                if (!nestedStacks.includes(newEvents[i].PhysicalResourceId)) {
                  // Logic to fetch events from nested stack within the parent stacks
                  if (newEvents[i].PhysicalResourceId.includes('arn:aws:cloudformation')) {
                    /*eslint-disable*/
                    nestedStackEventPromises.push(self.getNestedStackEvents(newEvents[i].PhysicalResourceId));
                    /* eslint-enable */
                    nestedStacks.push(newEvents[i].PhysicalResourceId);
                  }
                }
              }

              return Promise.all(nestedStackEventPromises)
                .then((nestedstackEvents) => {
                  newEvents = nestedstackEvents.reduce((combinedEventList, nestedstackEventList) =>
                    combinedEventList.concat(nestedstackEventList), newEvents);
                  // Just get the new events to display to the user

                  newEvents = _.differenceBy(newEvents, allShownEvents, 'EventId');
                  newEvents = _.uniqBy(newEvents, 'EventId');
                  showEvents(newEvents);
                  allShownEvents = allShownEvents.concat(newEvents);
                });
            }
          }
        }
      });
    }, 10000); // Poll for any events every 10 seconds
  }

  getNestedStackEvents(stackName) {
    const self = this;
    return this.cfn.describeStackEvents({ StackName: stackName }).promise()
      .then((data) => {
        let nestedstackEvents = data.StackEvents;
        nestedstackEvents = nestedstackEvents.filter(event =>
          self.eventStartTime < new Date(event.Timestamp));

        return nestedstackEvents;
      });
  }

  updateResourceStack(dir, cfnFile) {
    const filePath = path.normalize(path.join(dir, cfnFile));
    const projectDetails = this.context.awsmobile.getProjectDetails();
    const stackName = projectDetails.awsmobileMeta.provider ? projectDetails.awsmobileMeta.provider[providerName].StackName : '';
    const deploymentBucketName = projectDetails.awsmobileMeta.provider ? projectDetails.awsmobileMeta.provider[providerName].DeploymentBucket : '';
    if (!stackName) {
      throw (new Error('Project Stack is not yet created. Please use awsmobile init to initialize the project.'));
    }
    if (!deploymentBucketName) {
      throw (new Error('Project deployment bucket is not yet created. Please use awsmobile init to initialize the project.'));
    }

    return new S3(this.context)
      .then((s3) => {
        const s3Params = {
          Body: fs.createReadStream(filePath),
          Key: cfnFile,
        };
        return s3.uploadFile(s3Params);
      })
      .then((bucketName) => {
        const templateURL = `https://s3.amazonaws.com/${bucketName}/${cfnFile}`;
        const cfnStackCheckParams = {
          StackName: stackName,
        };
        const cfnModel = this.cfn;
        const { context } = this;
        const self = this;

        this.eventStartTime = new Date();

        return new Promise((resolve, reject) => {
          cfnModel.describeStacks(cfnStackCheckParams, (err) => {
            if (err) {
              reject(new Error("Project stack doesn't exist"));
              context.print.info(err.stack);
            }
            const cfnParentStackParams = {
              StackName: stackName,
              TemplateURL: templateURL,
              Capabilities: ['CAPABILITY_NAMED_IAM'],
              Parameters: [
                {
                  ParameterKey: 'DeploymentBucketName',
                  ParameterValue: deploymentBucketName,
                },
              ],
            };

            cfnModel.updateStack(cfnParentStackParams, (updateErr) => {
              self.readStackEvents(stackName);

              const cfnCompleteStatus = 'stackUpdateComplete';
              if (updateErr) {
                console.error('Error updating cloudformation stack');
                reject(updateErr);
              }
              cfnModel.waitFor(cfnCompleteStatus, cfnStackCheckParams, (completeErr) => {
                self.eventComplete = true;
                if (completeErr) {
                  console.error('Error updating cloudformation stack');
                  reject(completeErr);
                } else {
                  return self.updateAwsmobileMetaFileWithStackOutputs(stackName)
                    .then(() => resolve());
                }
              });
            });
          });
        });
      });
  }

  updateAwsmobileMetaFileWithStackOutputs(parentStackName) {
    const cfnParentStackParams = {
      StackName: parentStackName,
    };
    const projectDetails = this.context.awsmobile.getProjectDetails();
    const { awsmobileMeta } = projectDetails;

    const cfnModel = this.cfn;
    return cfnModel.describeStackResources(cfnParentStackParams).promise()
      .then((result) => {
        let resources = result.StackResources;
        resources = resources.filter(resource => resource.LogicalResourceId !== 'DeploymentBucket');
        const promises = [];

        for (let i = 0; i < resources.length; i += 1) {
          if (resources[i].LogicalResourceId === 'DeploymentBucket') {
            continue;
          }
          const cfnNestedStackParams = {
            StackName: resources[i].PhysicalResourceId,
          };
          promises.push(cfnModel.describeStacks(cfnNestedStackParams).promise());
        }

        return Promise.all(promises)
          .then((stackResult) => {
            Object.keys((awsmobileMeta)).forEach((category) => {
              Object.keys((awsmobileMeta[category])).forEach((resource) => {
                const logicalResourceId = category + resource;
                const index = resources.findIndex(resourceItem =>
                  resourceItem.LogicalResourceId ===
                    logicalResourceId);

                if (index !== -1) {
                  this.context.awsmobile.updateAwsMobileMetaAfterResourceUpdate(category, resource, 'output', formatOutputs(stackResult[index].Stacks[0].Outputs));
                }
              });
            });
          });
      });
  }

  deleteResourceStack() {
    const projectDetails = this.context.awsmobile.getProjectDetails();
    const stackName = projectDetails.awsmobileMeta.provider ? projectDetails.awsmobileMeta.provider[providerName].parentStackName : '';
    if (!stackName) {
      throw new Error('Project stack does not exist');
    }

    const cfnStackParams = {
      StackName: stackName,
    };

    const cfnModel = this.cfn;

    return new Promise((resolve, reject) => {
      cfnModel.describeStacks(cfnStackParams, (err) => {
        let cfnDeleteStatus = 'stackCreateComplete';
        if (err === null) {
          cfnModel.deleteStack(cfnStackParams, (deleteErr) => {
            cfnDeleteStatus = 'stackDeleteComplete';
            if (deleteErr) {
              console.log(`Error deleting stack ${stackName}`);
              reject(deleteErr);
            }
            cfnModel.waitFor(cfnDeleteStatus, cfnStackParams, (completeErr) => {
              if (err) {
                console.log(`Error deleting stack ${stackName}`);
                reject(completeErr);
              } else {
                resolve();
              }
            });
          });
        } else {
          reject(err);
        }
      });
    });
  }
}

function formatOutputs(outputs) {
  const formattedOutputs = {};
  for (let i = 0; i < outputs.length; i += 1) {
    formattedOutputs[outputs[i].OutputKey] = outputs[i].OutputValue;
  }

  return formattedOutputs;
}

function showEvents(events) {
  console.log('\n');
  events = events.sort((a, b) => new Date(a.Timestamp) > new Date(b.Timestamp));

  console.log(columnify(events, { columns: ['ResourceStatus', 'LogicalResourceId', 'ResourceType', 'Timestamp', 'ResourceStatusReason'], showHeaders: false }));
}
module.exports = CloudFormation;
