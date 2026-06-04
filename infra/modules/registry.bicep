targetScope = 'resourceGroup'

@description('Globally unique ACR name (alphanumeric only, 5-50 chars).')
param name string
param location string = resourceGroup().location
param tags object = {}

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    // Pull is via managed identity (AcrPull role) — admin user stays disabled.
    adminUserEnabled: false
  }
}

output name string = containerRegistry.name
output loginServer string = containerRegistry.properties.loginServer
