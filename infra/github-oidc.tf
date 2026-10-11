# --- GitHub Actions OIDC for CI/CD deploys ---

resource "aws_iam_openid_connect_provider" "github_actions" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["ffffffffffffffffffffffffffffffffffffffff"]

  tags = { Name = "${var.project_name}-github-oidc" }
}

data "aws_caller_identity" "current" {}

resource "aws_iam_role" "github_actions_prod" {
  name = "${var.project_name}-github-actions-prod"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.github_actions.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          StringLike = {
            "token.actions.githubusercontent.com:sub" = "repo:trycycloid/cycloid:ref:refs/heads/main"
          }
        }
      }
    ]
  })

  tags = { Name = "${var.project_name}-github-actions-prod" }
}

resource "aws_iam_role_policy" "github_actions_prod_deploy" {
  name = "deploy"
  role = aws_iam_role.github_actions_prod.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParametersByPath",
        ]
        Resource = [
          "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/cycloid",
          "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/cycloid/*",
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameters",
        ]
        Resource = [
          aws_ssm_parameter.env["CI_AUTOMATION_TOKEN"].arn,
          aws_ssm_parameter.env["E2B_API_KEY"].arn,
        ]
      },
      {
        Effect = "Deny"
        Action = [
          "ssm:GetParametersByPath",
        ]
        Condition = {
          StringEquals = {
            "ssm:Recursive" = "true"
          }
        }
        Resource = [
          "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/cycloid",
          "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/cycloid/*",
        ]
      },
    ]
  })
}

resource "aws_iam_role" "github_actions_qa" {
  name = "${var.project_name}-github-actions-qa"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.github_actions.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          StringLike = {
            "token.actions.githubusercontent.com:sub" = "repo:trycycloid/cycloid:ref:refs/heads/*"
          }
        }
      }
    ]
  })

  tags = { Name = "${var.project_name}-github-actions-qa" }
}

resource "aws_iam_role_policy" "github_actions_qa_deploy" {
  name = "deploy"
  role = aws_iam_role.github_actions_qa.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParametersByPath",
        ]
        Resource = [
          "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/cycloid/qa",
          "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/cycloid/qa/*",
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameters",
        ]
        Resource = [
          aws_ssm_parameter.qa_env["CI_AUTOMATION_TOKEN"].arn,
          aws_ssm_parameter.qa_env["E2B_API_KEY"].arn,
        ]
      },
    ]
  })
}
