#!/bin/bash
# Push para o Azure DevOps usando o token do az (rode depois que o repo existir).
set -e
TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv)
git -c http.extraHeader="Authorization: Bearer $TOKEN" push -u origin main
echo "Enviado: https://dev.azure.com/Sittax/Sittax/_git/sittax-qa-tools"
